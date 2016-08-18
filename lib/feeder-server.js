'use strict';

const SMTPServer = require('smtp-server').SMTPServer;
const config = require('config');
const log = require('npmlog');
const MessageParser = require('./message-parser');
const uuid = require('uuid');
const os = require('os');
const fs = require('fs');
const addressparser = require('addressparser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const RspamdClient = require('./rspamd-client');
const punycode = require('punycode');
const hostname = os.hostname();
const isemail = require('isemail');
const fetch = require('nodemailer-fetch');
const urllib = require('url');
const sendingZone = require('./sending-zone');

class FeederServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.createServer();
    }

    createServer() {
        this.server = false;
    }

    setup(callback) {
        // Setup server

        let key;
        let cert;

        /**
         * Fetches file contents by file path or returns the file value if it seems
         * like its already file contents and not file path
         *
         * @param {String/Buffer/false} file Either file contents or a path
         * @param {Function} done Returns the file contents or false
         */
        let getFile = (file, done) => {
            if (!file) {
                return setImmediate(done);
            }
            // if the value seems like file contents, return it as is
            if (Buffer.isBuffer(file) || /\n/.test(file)) {
                return done(null, file);
            }
            // otherwise try to load contents from a file path
            fs.readFile(file, done);
        };

        let getKeyfiles = done => {
            getFile(config.feeder.key, (err, file) => {
                if (!err && file) {
                    key = file;
                }
                getFile(config.feeder.cert, (err, file) => {
                    if (!err && file) {
                        cert = file;
                    }
                    done();
                });
            });
        };

        getKeyfiles(() => {
            this.server = new SMTPServer({
                // log to console
                logger: config.log.feeder ? {
                    info: log.silly.bind(log, 'Feeder'),
                    debug: log.silly.bind(log, 'Feeder'),
                    error: log.error.bind(log, 'Feeder')
                } : false,

                // not required but nice-to-have
                banner: 'Welcome to ZoneMTA',

                // No authentication at this point
                disabledCommands: []
                    .concat(!config.feeder.authentication ? 'AUTH' : [])
                    .concat(!config.feeder.starttls ? 'STARTTLS' : []),

                secure: config.feeder.secure,
                key,
                cert,

                // Socket timeout is set to 10 minutes. This is needed to give enought time
                // for the server to process large recipients lists
                socketTimeout: 10 * 60 * 1000,

                onRcptTo(address, session, callback) {
                    if (session.envelope.rcptTo && session.envelope.rcptTo.length >= config.maxRecipients) {
                        let err = new Error('Too many recipients');
                        err.responseCode = 452;
                        return setImmediate(() => callback(err));
                    }
                    if (!isemail.validate(address.address)) {
                        let err = new Error('The recipient address <' + address.address + '> is not a valid RFC-5321 address.');
                        err.responseCode = 553;
                        return setImmediate(() => callback(err));
                    }
                    return setImmediate(callback); // Accept the address
                },

                onAuth: (auth, session, next) => {
                    if (!auth.username || !auth.password || auth.username.length > 1024 || auth.password.length > 1024) {
                        return next(new Error('Invalid username or password'));
                    }

                    let urlparts = urllib.parse(config.feeder.authUrl);
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

            return callback();
        });
    }

    start(callback) {

        let listen = () => {
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
        };

        if (this.server) {
            return listen();
        } else {
            this.setup(listen);
        }
    }

    close(callback) {
        this.closing = true;
        this.server.close(callback);
    }

    handleMessage(stream, session, callback) {
        if (!this.queue) {
            // queue is not yet set, reject connection
            let err = new Error('DB not initialized');
            err.responseCode = 451;
            return callback(err);
        }

        let id = this.queue.seqIndex.get();
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

        if (session.tlsOptions) {
            envelope.tls = session.tlsOptions;
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
            if (config.feeder.allowFutureMessages && date && dateVal.toString() !== 'Invalid Date' && dateVal.getTime() > Date.now() + 5 * 60 * 1000) {
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

        if (config.rspamd.enabled) {
            rspamdStream = new RspamdClient({
                url: config.rspamd.url,
                from: envelope.from,
                to: envelope.to,
                user: session.user,
                id
            });

            rspamdStream.on('fail', err => {
                log.error('RSPAMD', err);
            });

            rspamdStream.on('response', response => {
                // store spam result
                spam = response;
            });

        } else {
            rspamdStream = new PassThrough();
        }


        if (config.dkim.enabled) {
            dkimStream = new DkimRelaxedBody(config.dkim);
            dkimStream.on('hash', bodyHash => {
                // store relaxed body hash for signing
                envelope.bodyHash = bodyHash;
            });
        } else {
            dkimStream = new PassThrough();
        }

        stream.pipe(rspamdStream);
        rspamdStream.pipe(message);
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

            if (config.rspamd.rejectSpam && spam && spam.default && spam.default.is_spam) {
                err = new Error('This message was classified as SPAM and may not be delivered');
                err.responseCode = 550;
                log.info('Feeder', 'REJECTED as spam %s: (From: %s; To: %s)', envelope.messageId || id, envelope.from, toList);
                return callback(err);
            }

            // inject message headers to the stored stream
            this.queue.setMeta(id, {
                hashAlgo: config.dkim.hash,
                bodyHash: envelope.bodyHash,
                body: message.bodySize,
                headers: headers.getList(),
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

module.exports = options => new FeederServer(options);
