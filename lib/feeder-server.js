'use strict';

const SMTPServer = require('smtp-server').SMTPServer;
const config = require('config');
const log = require('npmlog');
const fs = require('fs');
const isemail = require('isemail');
const MailDrop = require('./mail-drop');
const plugins = require('./plugins');
const packageData = require('../package.json');
const addressTools = require('./address-tools');
const SizeLimiter = require('./size-limiter');

class FeederServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.maildrop = new MailDrop(config);
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
                banner: 'Welcome to ' + config.name + (!config.feeder.disableVersionString ? '! [' + packageData.name + '/' + packageData.version + ']' : ''),

                size: config.feeder.maxSize,

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

                onMailFrom: (address, session, callback) => {
                    plugins.handler.runHooks('feeder:mail_from', [address, session], err => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }
                        setImmediate(callback); // Accept the address
                    });
                },

                onRcptTo(address, session, callback) {
                    if (session.envelope.rcptTo && session.envelope.rcptTo.length >= config.feeder.maxRecipients) {
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

                    plugins.handler.runHooks('feeder:rcpt_to', [address, session], err => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }
                        setImmediate(callback); // Accept the address
                    });
                },

                onAuth: (auth, session, next) => {
                    if (!auth.username || !auth.password || auth.username.length > 1024 || auth.password.length > 1024) {
                        return next(new Error('Invalid username or password'));
                    }

                    plugins.handler.runHooks('feeder:auth', [auth, session], err => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }

                        return next(null, {
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
            this.server.once('error', err => {
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
            id: this.queue.seqIndex.get(),
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

        plugins.handler.runHooks('feeder:data', [envelope, session], err => {
            if (err) {
                return setImmediate(() => callback(err));
            }

            let sizeLimiter = new SizeLimiter({
                maxSize: config.feeder.maxSize
            });

            stream.pipe(sizeLimiter);
            sizeLimiter.once('error', err => {
                stream.emit('error', err);
            });

            stream.on('error', err => callback(err));

            this.maildrop.add(envelope, sizeLimiter, callback);
        });
    }

}

module.exports = options => new FeederServer(options);
