'use strict';

const SMTPServer = require('smtp-server').SMTPServer;
const log = require('npmlog');
const fs = require('fs');
const isemail = require('isemail');
const MailDrop = require('./mail-drop');
const plugins = require('./plugins');
const packageData = require('../package.json');
const addressTools = require('./address-tools');
const SizeLimiter = require('./size-limiter');

class SMTPInterface {
    constructor(name, smtpInterface, options) {
        this.name = name; // application name
        this.interface = smtpInterface; // interface identifier
        this.logName = 'smtp:' + smtpInterface;
        this.options = options || {}; // configuration for this interface

        this.queue = false;
        this.closing = false;
        this.maildrop = new MailDrop();
        this.createServer();
    }

    createServer() {
        this.server = false;
    }

    setQueue(queue) {
        this.queue = this.maildrop.queue = queue;
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
            getFile(this.options.key, (err, file) => {
                if (!err && file) {
                    key = file;
                }
                getFile(this.options.cert, (err, file) => {
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
                logger: this.options.logger ? {
                    info: log.silly.bind(log, this.options.name),
                    debug: log.silly.bind(log, this.options.name),
                    error: log.error.bind(log, this.options.name)
                } : false,

                // not required but nice-to-have
                banner: 'Welcome to ' + this.name + (!this.options.disableVersionString ? '! [' + packageData.name + '/' + packageData.version + ']' : ''),

                size: this.options.maxSize,

                // No authentication at this point
                disabledCommands: []
                    .concat(!this.options.authentication ? 'AUTH' : [])
                    .concat(!this.options.starttls ? 'STARTTLS' : []),

                secure: this.options.secure,
                key,
                cert,

                // Socket timeout is set to 10 minutes. This is needed to give enought time
                // for the server to process large recipients lists
                socketTimeout: 10 * 60 * 1000,

                onMailFrom: (address, session, callback) => {
                    if (this.closing) {
                        return callback(new Error('Server shutdown in progress'));
                    }

                    session.envelopeId = this.queue.seqIndex.get();
                    plugins.handler.runHooks('smtp:mail_from', [address, session], err => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }
                        setImmediate(callback); // Accept the address
                    });
                },

                onRcptTo(address, session, callback) {
                    if (this.closing) {
                        return callback(new Error('Server shutdown in progress'));
                    }

                    if (session.envelope.rcptTo && session.envelope.rcptTo.length >= this.options.maxRecipients) {
                        let err = new Error('Too many recipients');
                        err.responseCode = 452;
                        return setImmediate(() => callback(err));
                    }

                    if (
                        isemail.validate(
                            // monkey patch unicode character support by replacing non ascii chars with 'x'
                            // we do not use the built in DNS resolving by isemail, so it should
                            // not break anything but it allows us to use unicode usernames
                            (address.address || '').replace(/[\u0080-\uFFFF]/g, 'x'), {
                                // method returns 0 if the error level is lower than 17
                                // below 17: address is valid for SMTP but has unusual elements
                                errorLevel: 17
                            })) {

                        let err = new Error('The recipient address <' + address.address + '> is not a valid RFC-5321 address.');
                        err.responseCode = 553;

                        return setImmediate(() => callback(err));
                    }

                    plugins.handler.runHooks('smtp:rcpt_to', [address, session], err => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }
                        setImmediate(callback); // Accept the address
                    });
                },

                onAuth: (auth, session, next) => {
                    if (this.closing) {
                        return callback(new Error('Server shutdown in progress'));
                    }

                    if (!auth.username || !auth.password || auth.username.length > 1024 || auth.password.length > 1024) {
                        log.info(this.logName, 'Failed auth of "%s" from %s[%s] using %s: %s', auth.username, session.clientHostname || session.hostNameAppearsAs, session.remoteAddress, auth.method, 'Invalid credentials');
                        return next(new Error('Invalid username or password'));
                    }

                    plugins.handler.runHooks('smtp:auth', [auth, session], err => {
                        if (err) {
                            log.info(this.logName, 'Failed auth of "%s" from %s[%s] using %s: %s', auth.username, session.clientHostname || session.hostNameAppearsAs, session.remoteAddress, auth.method, err.message);
                            return setImmediate(() => callback(err));
                        }

                        log.info(this.logName, 'Authenticated "%s" from %s[%s] using %s', auth.username, session.clientHostname || session.hostNameAppearsAs, session.remoteAddress, auth.method);

                        return next(null, {
                            user: auth.username
                        });
                    });
                },

                // Handle message stream
                onData: (stream, session, callback) => {
                    if (this.closing) {
                        return callback(new Error('Server shutdown in progress'));
                    }

                    this.handleMessage(stream, session, callback);
                },

                onConnect: (session, callback) => {
                    session.interface = this.interface;
                    callback();
                }
            });

            this.server.on('connect', data => {
                let hostname = '[' + data.remoteAddress + ']';
                if (data.clientHostname && data.clientHostname.charAt(0) !== '[') {
                    hostname = data.clientHostname + hostname;
                }
                log.info(this.logName, 'Connection from %s:%s', hostname, data.remotePort);
            });

            return callback();
        });
    }

    start(callback) {

        let listen = () => {
            let returned = false;
            this.server.once('error', err => {
                if (returned) {
                    log.error(this.logName, err);
                    return;
                }
                returned = true;
                callback(err);
            });

            // start listening
            this.server.listen(this.options.port, this.options.host, () => {
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
        if (this.server) {
            this.server.close(callback);
        }
    }

    handleMessage(stream, session, callback) {
        if (!this.queue) {
            // queue is not yet set, reject connection
            let err = new Error('DB not initialized');
            err.responseCode = 451;
            return callback(err);
        }

        let envelope = {
            id: session.envelopeId,
            interface: this.interface,
            from: addressTools.normalizeAddress(session.envelope.mailFrom.address || ''),
            to: session.envelope.rcptTo.map(item => addressTools.normalizeAddress(item.address)),
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

        plugins.handler.runHooks('smtp:data', [envelope, session], err => {
            if (err) {
                return setImmediate(() => callback(err));
            }

            let sizeLimiter = new SizeLimiter({
                maxSize: this.options.maxSize
            });

            stream.pipe(sizeLimiter);
            sizeLimiter.once('error', err => {
                stream.emit('error', err);
            });

            stream.on('error', err => callback(err));

            this.maildrop.add(envelope, sizeLimiter, (err, message) => {
                if (err) {
                    if (err.name === 'SMTPResponse') {
                        return callback(null, err.message);
                    }
                    return callback(err);
                }
                callback(null, message);
            });
        });
    }

}

module.exports = SMTPInterface;
