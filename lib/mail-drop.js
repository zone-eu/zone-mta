'use strict';

const log = require('npmlog');
const MessageParser = require('./message-parser');
const uuid = require('uuid');
const os = require('os');
const addressparser = require('addressparser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const plugins = require('./plugins');
const punycode = require('punycode');
const hostname = os.hostname();
const libmime = require('libmime');
const mailsplit = require('mailsplit');
const sendingZone = require('./sending-zone');

class MailDrop {
    constructor(options) {
        this.options = options || {};
        this.queue = false;
    }

    add(id, envelope, source, callback) {
        if (!this.queue) {
            return callback(new Error('Mailqueue not set up'));
        }

        id = id || this.queue.seqIndex.get();
        envelope = envelope || {};
        envelope.id = id;

        if (typeof source === 'string') {
            let messageBuf = Buffer.from(source);
            source = new PassThrough();
            source.end(messageBuf);
        } else if (Buffer.isBuffer(source)) {
            let messageBuf = source;
            source = new PassThrough();
            source.end(messageBuf);
        }

        // Create capped list of recipient addresses for logging
        let toList = [].concat(envelope.to);
        if (toList.length > 5) {
            let listlength = toList.length;
            toList = toList.slice(0, 4);
            toList.push('and ' + (listlength - toList.length) + ' more...');
        }
        toList = toList.join(',');

        let message = new MessageParser();
        message.onHeaders = (headers, next) => {
            envelope.headers = headers;

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

            // Check From: value. Add if missing or rewrite if needed
            let from = addressparser(headers.getFirst('from'));
            if (!from.length || from.length > 1 || envelope.rewriteFrom) {
                let rewriteFrom = envelope.rewriteFrom || {};
                if (typeof rewriteFrom === 'string') {
                    rewriteFrom = addressparser(rewriteFrom).shift() || {};
                }
                from = from.shift() || {};

                if (from.group) {
                    from = {};
                }

                try {
                    from.name = libmime.decodeWords(from.name || rewriteFrom.name || '');
                } catch (E) {
                    // most probably an unknown charset was used
                    from.name = from.name || rewriteFrom.name || '';
                }

                if (!/^[\w ']*$/.test(from.name)) { // check if only contains letters and numbers and such
                    if (/^[\x20-\x7e]*$/.test(from.name)) { // check if only contains ascii characters
                        from.name = '"' + from.name.replace(/([\\"])/g, '\\$1') + '"';
                    } else { // requires mime encoding
                        from.name = libmime.encodeWord(from.name, 'Q', 52);
                    }
                }

                from.address = rewriteFrom.address || from.address || envelope.from || ('auto-generated@' + hostname);
                headers.update('From', from.name ? from.name + ' <' + from.address + '>' : from.address);

                if (rewriteFrom.address) {
                    envelope.from = rewriteFrom.address;
                }
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
            if (this.options.feeder && this.options.allowFutureMessages && date && dateVal.toString() !== 'Invalid Date' && dateVal.getTime() > Date.now() + 5 * 60 * 1000) {
                // The date is in the future, defer the message. Max defer time is 1 year
                envelope.deferDelivery = Math.min(dateVal.getTime(), Date.now() + 365 * 24 * 3600 * 1000);
            }

            envelope.date = date;

            // Fetch sender and receiver addresses
            envelope.parsedEnvelope = {
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

            plugins.runHooks('message:headers', [envelope, headers], err => {
                if (err) {
                    return setImmediate(() => next(err));
                }
                setImmediate(next);
            });
        };

        let raw = new PassThrough();
        let splitter = new mailsplit.Splitter({
            ignoreEmbedded: true
        });

        envelope.dkim = envelope.dkim || {};
        envelope.dkim.hashAlgo = envelope.dkim.hashAlgo || (this.options.dkim && this.options.dkim.hashAlgo) || 'sha256';
        envelope.dkim.debug = this.options.dkim && this.options.dkim.debug;

        let dkimStream = new DkimRelaxedBody(envelope.dkim);
        dkimStream.on('hash', bodyHash => {
            // store relaxed body hash for signing
            envelope.dkim.bodyHash = bodyHash;
            envelope.bodySize = dkimStream.byteLength;
        });

        plugins.runAnalyzerHooks(envelope, source, raw);
        raw.pipe(splitter);
        plugins.runRewriteHooks(envelope, splitter, message);
        message.pipe(dkimStream);

        // pass on errors
        source.once('error', err => {
            raw.emit('error', err);
        });

        raw.once('error', err => {
            splitter.emit('error', err);
        });

        message.once('error', err => {
            dkimStream.emit('error', err);
        });

        // store stream to db
        this.queue.store(id, dkimStream, err => {
            if (err) {
                if (source.readable) {
                    source.resume(); // let the original stream to end normally before displaying the error message
                }
                log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                return callback(err);
            }

            plugins.runHooks('message:store', [envelope, message.headers], err => {
                if (err) {
                    return setImmediate(() => callback(err));
                }

                // convert headers object to a serialized array
                envelope.headers = envelope.headers ? envelope.headers.getList() : [];

                // inject message headers to the stored stream
                this.queue.setMeta(id, envelope, err => {
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
