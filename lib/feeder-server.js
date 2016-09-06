'use strict';

const SMTPServer = require('smtp-server').SMTPServer;
const config = require('config');
const log = require('npmlog');
const fs = require('fs');
const isemail = require('isemail');
const MailDrop = require('./mail-drop');
const iptools = require('./iptools');
const userTools = require('./user-tools');
const packageData = require('../package.json');

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
                    let mailFrom = this.maildrop.normalizeAddress(address && address.address || address);
                    userTools.getSenderConfig(mailFrom, session, (err, senderConfig) => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }
                        session.senderConfig = senderConfig;
                        setImmediate(callback); // Accept the address
                    });
                },

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

                    iptools.resolveMx(address.address.split('@').pop(), (err, list) => {
                        if (err || !list) {
                            let err = new Error('Can\'t find an MX server for <' + address.address + '>');
                            err.responseCode = 550;
                            return setImmediate(() => callback(err));
                        }

                        setImmediate(callback); // Accept the address
                    });
                },

                onAuth: (auth, session, next) => {
                    if (!auth.username || !auth.password || auth.username.length > 1024 || auth.password.length > 1024) {
                        return next(new Error('Invalid username or password'));
                    }

                    userTools.authenticate(config.feeder.authUrl, {
                        username: auth.username,
                        password: auth.password,
                        transport: 'SMTP'
                    }, (err, success) => {
                        if (err) {
                            return next(err);
                        }
                        if (success) {
                            return next(null, {
                                user: auth.username
                            });
                        }
                        next(null, false);
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
            from: this.maildrop.normalizeAddress(session.envelope.mailFrom.address || ''),
            to: session.envelope.rcptTo.map(item => this.maildrop.normalizeAddress(item.address)),
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

        // apply configuration from sender config server
        if (session.senderConfig && typeof session.senderConfig === 'object') {
            Object.keys(session.senderConfig).forEach(key => {
                envelope[key] = session.senderConfig[key];
            });
        }

        this.maildrop.add(id, envelope, stream, callback);
    }

}

module.exports = options => new FeederServer(options);
