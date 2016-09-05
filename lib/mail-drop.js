'use strict';

const log = require('npmlog');
const MessageParser = require('./message-parser');
const uuid = require('uuid');
const os = require('os');
const addressparser = require('addressparser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const RspamdClient = require('./rspamd-client');
const punycode = require('punycode');
const hostname = os.hostname();
const mailsplit = require('mailsplit');
const sendingZone = require('./sending-zone');
const createHtmlRewriter = require('./html-rewriter');

class MailDrop {
    constructor(options) {
        this.options = options || {};
        this.queue = false;
    }

    add(id, envelope, stream, callback) {
        if (!this.queue) {
            return callback(new Error('Mailqueue not set up'));
        }

        id = id || this.queue.seqIndex.get();
        envelope = envelope || {};

        if (typeof stream === 'string') {
            let messageBuf = Buffer.from(stream);
            stream = new PassThrough();
            stream.end(messageBuf);
        } else if (Buffer.isBuffer(stream)) {
            let messageBuf = stream;
            stream = new PassThrough();
            stream.end(messageBuf);
        }

        // Create capped list of recipient addresses for logging
        let toList = [].concat(envelope.to);
        if (toList.length > 5) {
            let listlength = toList.length;
            toList = toList.slice(0, 4);
            toList.push('and ' + (listlength - toList.length) + ' more...');
        }
        toList = toList.join(',');

        let headers = false;

        let spam;
        let message = new MessageParser();
        let splitter = new mailsplit.Splitter({
            ignoreEmbedded: true
        });
        let rewriter;

        // setup rewriter
        if (this.options.rewrite && this.options.rewrite.enabled) {
            rewriter = createHtmlRewriter(id, envelope);
            splitter.pipe(rewriter).pipe(message);

            splitter.on('error', err => {
                rewriter.emit('error', err);
            });
            rewriter.on('error', err => {
                message.emit('error', err);
            });
        } else {
            splitter.pipe(message);
            splitter.on('error', err => {
                message.emit('error', err);
            });
        }

        let rspamdStream;
        let dkimStream;

        message.once('headers', headersObj => {
            headers = headersObj;

            // Check Message-ID: value. Add if missing
            let mId = headers.getFirst('message-id');
            if (!mId) {
                headers.remove('message-id'); // in case there's an empty value
                mId = '<' + uuid.v4() + '@' + (envelope.from.substr(envelope.from.lastIndexOf('@') + 1) || hostname) + '>';
                headers.add('Message-ID', mId);
            }
            envelope.messageId = mId;

            // Check Sending Zone for this message
            //   X-Sending-Zone: loopback
            // If Sending Zone is not set or missing then the default is used
            let sZone = headers.getFirst('x-sending-zone').toLowerCase();
            if (sZone) {
                log.verbose('Queue', 'Detected Zone %s for %s by headers', sZone, mId);
                envelope.sendingZone = sZone;
            }

            // Check From: value. Add if missing
            let from = headers.getFirst('from');
            if (!from) {
                headers.remove('from'); // in case there's an empty value
                headers.add('From', envelope.from || ('unknown@' + hostname));
            }

            // Check Date: value. Add if missing or invalid or future date
            let date = headers.getFirst('date');
            let dateVal = new Date(date);
            if (!date || dateVal.toString() === 'Invalid Date' || dateVal < new Date(1000)) {
                headers.remove('date'); // remove old empty or invalid values
                date = new Date().toUTCString().replace(/GMT/, '+0000');
                headers.add('Date', date);
            }

            // Check if Date header indicates a time in the future (+/- 300s clock skew is allowed)
            if (this.options.feeder && this.options.feeder.allowFutureMessages && date && dateVal.toString() !== 'Invalid Date' && dateVal.getTime() > Date.now() + 5 * 60 * 1000) {
                // The date is in the future, defer the message. Max defer time is 1 year
                envelope.deferDelivery = Math.min(dateVal.getTime(), Date.now() + 365 * 24 * 3600 * 1000);
            }

            envelope.date = date;

            // Fetch sender and receiver addresses
            envelope.headers = {
                from: this.parseAddressList(headers, 'from').shift() || false,
                to: this.parseAddressList(headers, 'to'),
                cc: this.parseAddressList(headers, 'cc'),
                bcc: this.parseAddressList(headers, 'bcc'),
                replyTo: this.parseAddressList(headers, 'reply-to').shift() || false,
                sender: this.parseAddressList(headers, 'sender').shift() || false
            };

            // Fetch X-FBL header for bounce tracking
            let xFbl = headers.getFirst('x-fbl').trim();
            if (xFbl) {
                envelope.fbl = xFbl;
            }

            // Remove sending-zone routing key if present
            headers.remove('x-sending-zone');

            // Remove BCC if present
            headers.remove('bcc');

            if (!envelope.sendingZone) {
                sZone = sendingZone.findByHeaders(headers);
                if (sZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s by headers', sZone, mId);
                    envelope.sendingZone = sZone;
                }
            }
        });

        if (this.options.rspamd && this.options.rspamd.enabled) {
            rspamdStream = new RspamdClient({
                url: this.options.rspamd.url,
                from: envelope.from,
                to: envelope.to,
                user: envelope.user,
                id
            });

            rspamdStream.on('fail', err => {
                log.error('Rspamd', err);
            });

            rspamdStream.on('response', response => {
                // store spam result
                spam = response;
            });

        } else {
            rspamdStream = new PassThrough();
        }

        if (this.options.dkim && this.options.dkim.enabled) {
            dkimStream = new DkimRelaxedBody(this.options.dkim);
            dkimStream.on('hash', bodyHash => {
                // store relaxed body hash for signing
                envelope.bodyHash = bodyHash;
            });
        } else {
            dkimStream = new PassThrough();
        }

        stream.pipe(rspamdStream);
        rspamdStream.pipe(splitter);
        message.pipe(dkimStream);

        // pass on errors
        stream.once('error', err => {
            rspamdStream.emit('error', err);
        });

        rspamdStream.once('error', err => {
            message.emit('error', err);
        });

        message.once('error', err => {
            stream.unpipe(message);
            dkimStream.emit('error', err);
        });

        // store stream to db
        this.queue.store(id, dkimStream, err => {
            if (err) {
                if (stream.readable) {
                    stream.resume(); // let the original stream to end normally before displaying the error message
                }
                log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                return callback(err);
            }

            if (this.options.rspamd && this.options.rspamd.rejectSpam && spam && spam.default && spam.default.is_spam) {
                err = new Error('This message was classified as SPAM and may not be delivered');
                err.responseCode = 550;
                log.info('Feeder', 'REJECTED as spam %s: score %s, tests=[%s] (From: %s; To: %s)', envelope.messageId || id, spam.default.score, spam.tests.join(','), envelope.from, toList);
                return callback(err);
            }

            // inject message headers to the stored stream
            this.queue.setMeta(id, {
                hashAlgo: this.options.dkim && this.options.dkim.hash,
                bodyHash: envelope.bodyHash,
                body: message.bodySize,
                headers: headers ? headers.getList() : [],
                spam
            }, err => {
                if (err) {
                    log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                    return callback(err);
                }

                // push delivery data
                this.queue.push(id, envelope, err => {
                    if (err) {
                        log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                        return callback(err);
                    }
                    log.info('Feeder', 'RECEIVED %s (From: %s; To: %s)', id, envelope.from, toList);
                    return setImmediate(() => callback(null, 'Message queued as ' + id));
                });
            });
        });
    }

    // helper function to flatten arrays
    flatten(arr) {
        let flat = [].concat(...arr);
        return flat.some(Array.isArray) ? this.flatten(flat) : flat;
    }

    convertAddresses(addresses, addressList) {
        addressList = addressList || new Set();

        this.flatten(addresses || []).forEach(address => {
            if (address.address) {
                addressList.add(this.normalizeAddress(address.address));
            } else if (address.group) {
                this.convertAddresses(address.group, addressList);
            }
        });

        return addressList;
    }

    parseAddressList(headers, key) {
        let set = this.convertAddresses(headers.getDecoded(key).map(header => addressparser(header.value)));
        return Array.from(set);
    }

    normalizeAddress(address) {
        if (!address) {
            return '';
        }
        let user = address.substr(0, address.lastIndexOf('@'));
        let domain = address.substr(address.lastIndexOf('@') + 1);
        return user.trim() + '@' + punycode.toASCII(domain.toLowerCase().trim());
    }
}

module.exports = MailDrop;
