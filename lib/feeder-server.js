'use strict';

const SMTPServer = require('smtp-server').SMTPServer;
const config = require('config');
const log = require('npmlog');
const MessageParser = require('./message-parser');
const uuid = require('uuid');
const os = require('os');
const addressparser = require('addressparser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const dkimSign = require('./dkim-sign');
const punycode = require('punycode');
const hostname = os.hostname();
const isemail = require('isemail');
const fetch = require('nodemailer-fetch');
const urllib = require('url');

class FeederServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.createServer();
    }

    createServer() {
        // Setup server
        this.server = new SMTPServer({
            // log to console
            logger: config.log.feeder ? {
                info: log.silly.bind(log, 'Feeder'),
                debug: log.silly.bind(log, 'Feeder'),
                error: log.error.bind(log, 'Feeder')
            } : false,

            // not required but nice-to-have
            banner: 'Welcome to My Awesome Anonymous Relay Server',

            // No authentication at this point
            disabledCommands: []
                .concat(!config.feeder.authentication ? 'AUTH' : [])
                .concat(!config.feeder.starttls ? 'STARTTLS' : []),

            secure: config.feeder.secure,
            key: config.feeder.key,
            cert: config.feeder.cert,

            onRcptTo(address, session, callback) {
                if (session.envelope.rcptTo && session.envelope.rcptTo.length >= config.maxRecipients) {
                    let err = new Error('Too many recipients');
                    err.responseCode = 452;
                    return callback(err);
                }
                if (!isemail.validate(address.address)) {
                    let err = new Error('The recipient address <' + address.address + '> is not a valid RFC-5321 address.');
                    err.responseCode = 553;
                    return callback(err);
                }
                return callback(); // Accept the address
            },

            onAuth: (auth, session, next) => {
                if (!auth.username || !auth.password || auth.username.length > 1024 || auth.password.length > 1024) {
                    return next(new Error('Invalid username or password'));
                }

                let urlparts = urllib.parse(config.feeder.authurl);
                urlparts.auth = encodeURIComponent(auth.username) + ':' + encodeURIComponent(auth.password);
                let returned = false;
                let req = fetch(urllib.format(urlparts));
                req.on('data', () => false);
                req.on('error', err => {
                    if (returned) {
                        return;
                    }
                    returned = true;
                    return next(err);
                });
                req.on('end', () => {
                    if (returned) {
                        return;
                    }
                    returned = true;
                    next(null, {
                        user: auth.username
                    });
                });
            },

            // Handle message stream
            onData: (stream, session, callback) => {
                this.handleMessage(stream, session, callback);
            }
        });
    }

    start(callback) {
        let returned = false;
        this.server.on('error', err => {
            if (returned) {
                log.error('Feeder', err);
                return;
            }
            returned = true;
            callback(err);
        });

        // start listening
        this.server.listen(config.feeder.port, config.feeder.host, () => {
            if (returned) {
                return;
            }
            returned = true;
            callback(null, true);
        });
    }

    close(callback) {
        this.closing = true;
        this.server.close(callback);
    }

    handleMessage(stream, session, callback) {
        if (!this.queue) {
            // queue is not yet set, reject connection

        }
        let envelope = {
            from: this.normalizeAddress(session.envelope.mailFrom.address || ''),
            to: session.envelope.rcptTo.map(item => this.normalizeAddress(item.address)),
            origin: session.remoteAddress,
            originhost: session.clientHostname,
            transhost: session.hostNameAppearsAs,
            transtype: session.transmissionType,
            user: session.user,
            time: Date.now()
        };

        // Create capped list of recipient addresses for logging
        let toList = [].concat(envelope.to);
        if (toList.length > 5) {
            let listlength = toList.length;
            toList = toList.slice(0, 4);
            toList.push('and ' + (listlength - toList.length) + ' more...');
        }
        toList = toList.join(',');

        let headers = false;
        let message = new MessageParser();
        let dkimStream;

        message.on('headers', headersObj => {
            headers = headersObj;

            // Check Sending Zone for this message
            //   X-Sending-Zone: loopback
            // If Sending Zone is not set or missing then the default is used
            let sZone = headers.getFirst('x-sending-zone').toLowerCase();
            if (sZone) {
                envelope.sendingZone = sZone;
            }

            // Check Message-ID: value. Add if missing
            let mId = headers.getFirst('message-id');
            if (!mId) {
                headers.remove('message-id'); // in case there's an empty value
                mId = '<' + uuid.v4() + '@' + (envelope.from.substr(envelope.from.lastIndexOf('@') + 1) || hostname) + '>';
                headers.add('Message-ID', mId);
            }
            envelope.messageId = mId;

            // Check From: value. Add if missing
            let from = headers.getFirst('from');
            if (!from) {
                headers.remove('from'); // in case there's an empty value
                headers.add('From', envelope.from || ('unknown@' + hostname));
            }

            // Check Date: value. Add if missing or invalid or future date
            let date = headers.getFirst('date');
            let dateVal = new Date(date);
            if (!date || dateVal.toString() === 'Invalid Date' || dateVal > new Date() || dateVal < new Date(1000)) {
                headers.remove('date'); // remove old empty or invalid values
                date = new Date().toUTCString().replace(/GMT/, '+0000');
                headers.add('Date', date);
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

            // Remove sending-zone routing key if present
            headers.remove('x-sending-zone');

            // Remove BCC if present
            headers.remove('bcc');
        });

        if (config.dkim.enabled) {
            dkimStream = new DkimRelaxedBody();
            dkimStream.on('hash', bodyHash => {
                envelope.bodyHash = bodyHash;

                let dkimKeys;
                let headerFrom = envelope.headers.from && envelope.headers.from.split('@').pop();
                let envelopeFrom = envelope.from && envelope.from.split('@').pop();

                if (dkimSign.keys.has(headerFrom)) {
                    dkimKeys = dkimSign.keys.get(headerFrom);
                } else if (dkimSign.keys.has(envelopeFrom)) {
                    dkimKeys = dkimSign.keys.get(envelopeFrom);
                }

                let dkimHeader;
                if (dkimKeys) {
                    dkimHeader = dkimSign.sign(headers, bodyHash, dkimKeys);
                    envelope.dkim = true;
                    headers.addFormatted('dkim-signature', dkimHeader);
                }
            });
        } else {
            dkimStream = new PassThrough();
        }

        stream.pipe(message);
        message.pipe(dkimStream);

        // pass on errors
        stream.once('error', err => {
            message.emit('error', err);
        });
        message.once('error', err => {
            dkimStream.emit('error', err);
        });

        // store stream to db
        this.queue.store(dkimStream, (err, id) => {
            if (err) {
                log.error('Feeder', 'Error processing incoming message: %s (From: %s; To: %s)', err.message, envelope.from, toList);
                return callback(err);
            }

            // inject message headers to the stored stream

            // Create and insert the Received header
            /* // Received header is created immediatelly before sending to match correct hostname and recipient
            headers.add('Received',
                // from ehlokeyword
                'from' + (envelope.transhost ? ' ' + envelope.transhost : '') +
                // [1.2.3.4]
                ' [' + envelope.origin + ']' +
                // (Authenticated sender: username)
                (envelope.user ? ' (Authenticated sender: ' + envelope.user + ')' : '') +
                // by smtphost
                ' by ' + hostname +
                // (Zone-MTA)
                (config.name ? ' (' + config.name + ')' : '') +
                // with ESMTP
                ' with ' + envelope.transtype +
                // id 12345678
                ' id ' + id +
                // for <receiver@example.com>
                (envelope.to.length === 1 ? ' for <' + envelope.to[0] + '>' : '') +
                '; ' +
                // Wed, 03 Aug 2016 11:32:07 +0000
                new Date(envelope.time).toUTCString().replace(/GMT/, '+0000'),

                // If DKIMSignature exists push the Received header to position 1, otherwise to pos 0
                envelope.dkim ? 1 : 0);
            */

            let headerChunk = headers.build();
            this.queue.storePrepend(id, headerChunk, err => {
                if (err) {
                    log.error('Feeder', 'Error processing incoming message: %s (From: %s; To: %s)', err.message, envelope.from, toList);
                    return callback(err);
                }
                envelope.headerSize = headerChunk.length;
                envelope.bodySize = message.bodySize;

                // push delivery data
                this.queue.push(id, envelope, err => {
                    if (err) {
                        log.error('Feeder', 'Error processing incoming message: %s (From: %s; To: %s)', err.message, envelope.from, toList);
                        return callback(err);
                    }
                    log.info('Feeder', 'RECEIVED %s (From: %s; To: %s)', id, envelope.from, toList);
                    return callback(null, 'Message queued as ' + id);
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

module.exports = options => new FeederServer(options);
