/* eslint indent: 0 */
'use strict';

const SMTPServer = require('smtp-server').SMTPServer;
const log = require('npmlog');
const fs = require('fs');
const os = require('os');
const isemail = require('isemail');
const MailDrop = require('./mail-drop');
const plugins = require('./plugins');
const packageData = require('../package.json');
const addressTools = require('./address-tools');
const SizeLimiter = require('./size-limiter');
const RemoteQueue = require('./remote-queue');

class SMTPInterface {
    constructor(smtpInterface, options, sendCommand) {
        this.interface = smtpInterface; // interface identifier
        this.name = options.name || this.interface; // application name
        this.logName = 'SMTP/' + smtpInterface + '/' + process.pid;
        this.options = options || {}; // configuration for this interface

        this.children = new Set();
        this.processes = this.options.processes || 1;
        this.selector = false;

        this.sendCommand = sendCommand;

        this.closing = false;
        this.sendCommand = sendCommand;

        this.maildrop = false;
        this.queue = false;
    }

    setup(callback) {
        // Setup server

        let key;
        let cert;

        let getQueue = done => {
            if (!this.sendCommand) {
                // not available in proxy mode, no queue needed also
                return done();
            }
            // start in worker mode, set up queue handling
            this.queue = new RemoteQueue();
            this.queue.init(this.sendCommand, err => {
                if (err) {
                    log.error(this.logName, 'Queue error %s', err.message);
                    return process.exit(1);
                }
                this.maildrop = new MailDrop(this.queue);
                return done();
            });
        };

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
            key = process.env.ZONEMTA_TLS_KEY ? Buffer.from(process.env.ZONEMTA_TLS_KEY) : this.options.key;
            cert = process.env.ZONEMTA_TLS_CERT ? Buffer.from(process.env.ZONEMTA_TLS_CERT) : this.options.cert;

            getFile(key, (err, file) => {
                if (!err && file) {
                    key = file;
                    process.env.ZONEMTA_TLS_KEY = file.toString();
                }
                getFile(cert, (err, file) => {
                    if (!err && file) {
                        cert = file;
                        process.env.ZONEMTA_TLS_CERT = file.toString();
                    }
                    done();
                });
            });
        };

        getQueue(() => {
            getKeyfiles(() => {
                let serverConfig = {
                    // log to console
                    logger: this.options.logger
                        ? {
                              info: log.silly.bind(log, this.options.name),
                              debug: log.silly.bind(log, this.options.name),
                              error: log.error.bind(log, this.options.name)
                          }
                        : false,

                    name: this.options.hostname || os.hostname(),

                    banner: 'Welcome to ' + this.name + (!this.options.disableVersionString ? '! [' + packageData.name + '/' + packageData.version + ']' : ''),

                    size: this.options.maxSize,

                    // No authentication at this point
                    disabledCommands: [].concat(!this.options.authentication ? 'AUTH' : []).concat(!this.options.starttls ? 'STARTTLS' : []),

                    secure: this.options.secure,
                    needsUpgrade: this.options.secure,

                    key,
                    cert,

                    // Socket timeout is set to 10 minutes. This is needed to give enought time
                    // for the server to process large recipients lists
                    socketTimeout: this.options.socketTimeout || 10 * 60 * 1000,

                    onMailFrom: (address, session, callback) => {
                        if (this.closing) {
                            return callback(new Error('Server shutdown in progress'));
                        }

                        this.sendCommand('INDEX', (err, envelopeId) => {
                            if (err) {
                                this.closing = true;
                                log.error(this.logName, err.message);
                                process.exit(2);
                                return;
                            }

                            session.envelopeId = envelopeId;
                            plugins.handler.runHooks('smtp:mail_from', [address, session], err => {
                                if (err) {
                                    return setImmediate(() => callback(err));
                                }
                                setImmediate(callback); // Accept the address
                            });
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

                        let validation = isemail.validate(
                            // monkey patch unicode character support by replacing non ascii chars with 'x'
                            // we do not use the built in DNS resolving by isemail, so it should
                            // not break anything but it allows us to use unicode usernames
                            (address.address || '').replace(/[\u0080-\uFFFF]/g, 'x'),
                            {
                                // method returns 0 if the error level is lower than 17
                                // below 17: address is valid for SMTP but has unusual elements
                                errorLevel: 17
                            }
                        );

                        // 66: rfc5322TooLong
                        // 67: rfc5322LocalTooLong
                        if (validation && ![66, 67].includes(validation)) {
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
                            log.info(
                                this.logName,
                                'AUTHFAIL id=%s user="%s" srs=%s proto=%s error=%s',
                                session.id,
                                auth.username,
                                (session.clientHostname || session.hostNameAppearsAs) +
                                    ((session.clientHostname || session.hostNameAppearsAs || '').replace(/[[\]]/g, '') !== session.remoteAddress
                                        ? '[' + session.remoteAddress + ']'
                                        : ''),
                                auth.method,
                                'Invalid credentials'
                            );
                            return next(new Error('Invalid username or password'));
                        }

                        plugins.handler.runHooks('smtp:auth', [auth, session], err => {
                            if (err) {
                                log.info(
                                    this.logName,
                                    'AUTHFAIL id=%s user="%s" srs=%s proto=%s error=%s',
                                    session.id,
                                    auth.username,
                                    (session.clientHostname || session.hostNameAppearsAs) +
                                        ((session.clientHostname || session.hostNameAppearsAs || '').replace(/[[\]]/g, '') !== session.remoteAddress
                                            ? '[' + session.remoteAddress + ']'
                                            : ''),
                                    auth.method,
                                    err.message
                                );
                                return setImmediate(() => next(err));
                            }

                            log.info(
                                this.logName,
                                'AUTHSUCCESS id=%s user="%s" src=%s proto=%s',
                                session.id,
                                auth.username,
                                // %s[%s]
                                (session.clientHostname || session.hostNameAppearsAs) +
                                    ((session.clientHostname || session.hostNameAppearsAs || '').replace(/[[\]]/g, '') !== session.remoteAddress
                                        ? '[' + session.remoteAddress + ']'
                                        : ''),
                                auth.method
                            );

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
                };

                // apply additional config options (if set)
                [
                    'hideSize',
                    'authMethods',
                    'authOptional',
                    'disabledCommands',
                    'hideSTARTTLS',
                    'hidePIPELINING',
                    'hide8BITMIME',
                    'hideSMTPUTF8',
                    'allowInsecureAuth',
                    'disableReverseLookup',
                    'sniOptions',
                    'maxClients',
                    'useProxy',
                    'useXClient',
                    'useXForward',
                    'lmtp',
                    'closeTimeout'
                ].forEach(key => {
                    if (key in this.options && !(key in serverConfig)) {
                        serverConfig[key] = this.options[key];
                    }
                });

                this.server = new SMTPServer(serverConfig);

                this.server.on('connect', data => {
                    let hostname = '[' + data.remoteAddress + ']';
                    if (data.clientHostname && data.clientHostname.charAt(0) !== '[') {
                        hostname = data.clientHostname + hostname;
                    }
                    log.info(this.logName, 'CONNECTION id=%s src=%s:%s', data.id, hostname, data.remotePort);
                });

                return callback();
            });
        });
    }

    close(callback) {
        this.closing = true;
        if (this.server) {
            this.server.close(callback);
        }
    }

    handleMessage(stream, session, callback) {
        let envelope = {
            id: session.envelopeId,
            interface: this.interface,
            from: addressTools.normalizeAddress((session.envelope.mailFrom && session.envelope.mailFrom.address) || ''),
            to: session.envelope.rcptTo.map(item => addressTools.normalizeAddress(item.address)),
            origin: session.remoteAddress,
            originhost: session.clientHostname,
            transhost: session.hostNameAppearsAs,
            transtype: session.transmissionType,
            user: session.user,
            time: Date.now()
        };

        if (session.sendingZone) {
            envelope.sendingZone = session.sendingZone;
        }

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
                if (err.name === 'SMTPResponse') {
                    return callback(null, err.message);
                }
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
