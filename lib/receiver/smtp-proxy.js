'use strict';

const config = require('wild-config');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const log = require('npmlog');
const crypto = require('crypto');
const punycode = require('punycode/');
const child_process = require('child_process');
const plugins = require('../plugins');
const tlsOptions = require('smtp-server/lib/tls-options');

class SMTPProxy {
    constructor(smtpInterface, options) {
        this.name = smtpInterface;
        this.options = options || {};
        this.children = new Set();
        this.processes = this.options.processes || 1;
        this.selector = false;

        this.interface = smtpInterface;

        this.keyFiles = false;

        this.defaultSecureContext = false;

        config.on('reload', () => {
            this.children.forEach(child => {
                try {
                    child.kill('SIGHUP');
                } catch (E) {
                    //ignore
                }
            });
        });
    }

    spawnReceiver() {
        if (this.children.size >= this.processes) {
            return false;
        }

        let childId = crypto.randomBytes(10).toString('hex');
        let child = child_process.fork(
            __dirname + '/../../services/receiver.js',
            ['--interfaceName=' + this.name, '--interfaceId=' + childId].concat(process.argv.slice(2)),
            {
                env: process.env
            }
        );
        let pid = child.pid;

        child.on('close', (code, signal) => {
            this.children.delete(child);
            if (!this.closing) {
                log.error('SMTP/' + this.name + '/' + pid, 'Receiver process %s for %s exited with %s', childId, this.name, code || signal);

                // Respawn after 5 seconds
                setTimeout(() => this.spawnReceiver(), 5 * 1000).unref();
            }
        });

        this.children.add(child);
        if (this.children.size < this.processes) {
            setImmediate(() => this.spawnReceiver());
        }
    }

    socketEnd(socket, message) {
        let writeToSocket = () => {
            try {
                socket.end(message + '\r\n');
            } catch (E) {
                // ignore, probably socket already closed
            }
        };

        if (!this.options.secure) {
            return writeToSocket();
        }

        this.upgrade(socket, (err, tlsSocket) => {
            if (err) {
                log.error('SMTP/' + this.name, 'Failed setting up TLS. %s', err.message);
            }
            if (tlsSocket) {
                try {
                    tlsSocket.end(message + '\r\n');
                } catch (E) {
                    // ignore, probably socket already closed
                }
            }
        });
    }

    upgrade(socket, callback) {
        let returned = false;

        // we have a TLS client on the line, upgrade connection and return error message
        let socketOptions = {
            isServer: true,
            secureContext: this.defaultSecureContext,

            SNICallback: (servername, cb) => {
                let data = { socket };

                try {
                    servername = punycode.toUnicode((servername || '').toString().trim()).toLowerCase();
                } catch (E) {
                    this.logger.error(
                        {
                            tnx: 'punycode'
                        },
                        'Failed to process punycode domain "%s". error=%s',
                        servername,
                        E.message
                    );
                }

                plugins.handler.runHooks('smtp:sni', [servername, data], err => {
                    if (err) {
                        this.logger.error(
                            {
                                tnx: 'sni',
                                servername,
                                err
                            },
                            'Failed to fetch SNI context for servername %s',
                            servername
                        );
                    }

                    return cb(null, data.context || this.defaultSecureContext);
                });
            }
        };

        let remoteAddress = socket.remoteAddress;

        let onError = err => {
            if (returned) {
                return;
            }
            returned = true;

            if (err && /SSL[23]*_GET_CLIENT_HELLO|ssl[23]*_read_bytes|ssl_bytes_to_cipher_list/i.test(err.message)) {
                let message = err.message;
                err.message = 'Failed to establish TLS session';
                err.code = err.code || 'TLSError';
                err.meta = {
                    protocol: 'smtp',
                    stage: 'connect',
                    message,
                    remoteAddress
                };
            }
            if (!err || !err.message) {
                err = new Error('Socket closed while initiating TLS');
                err.code = 'SocketError';
                err.report = false;
                err.meta = {
                    protocol: 'smtp',
                    stage: 'connect',
                    remoteAddress
                };
            }

            callback(err || new Error('Socket closed unexpectedly'));
        };

        // remove all listeners from the original socket besides the error handler
        socket.once('error', onError);

        // upgrade connection
        let tlsSocket = new tls.TLSSocket(socket, socketOptions);

        let onCloseError = hadError => {
            if (hadError) {
                return onError();
            }
        };

        tlsSocket.once('close', onCloseError);
        tlsSocket.once('error', onError);
        tlsSocket.once('_tlsError', onError);
        tlsSocket.once('clientError', onError);
        tlsSocket.once('tlsClientError', onError);

        tlsSocket.on('secure', () => {
            socket.removeListener('error', onError);
            tlsSocket.removeListener('close', onCloseError);
            tlsSocket.removeListener('error', onError);
            tlsSocket.removeListener('_tlsError', onError);
            tlsSocket.removeListener('clientError', onError);
            tlsSocket.removeListener('tlsClientError', onError);
            if (returned) {
                try {
                    tlsSocket.end();
                } catch (E) {
                    //
                }
                return;
            }
            returned = true;
            return callback(null, tlsSocket);
        });
    }

    connection(socket) {
        // find a child to process connection
        if (!this.children.size) {
            return this.socketEnd(socket, '421 No free process to handle connection');
        }

        if (!this.selector) {
            this.selector = this.children.values();
        }
        let value = this.selector.next();
        if (value.done) {
            this.selector = this.children.values();
            value = this.selector.next();
        }
        if (value.done) {
            return this.socketEnd(socket, '421 No free process to handle connection');
        }

        let child = value.value;

        // Here be dragons!
        // https://github.com/nodejs/node/issues/8353#issuecomment-244092209
        // if we do not explicitly stop reading from the socket then we might
        // accidentally have some data in buffer that is not available for the child process
        socket._handle.readStop();
        let res;
        try {
            res = child.send('socket', socket);
        } catch (err) {
            log.error(this.logName, err);
            try {
                socket._handle.readStart();
            } catch (err) {
                log.error(this.logName, err);
            }
            return this.socketEnd(socket, '421 Failed to assign connection to child process');
        }
        return res;
    }

    start(callback) {
        let key;
        let ca;
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

                    let caFiles = [].concat(this.options.ca || []);
                    let caPos = 0;
                    let getCaCerts = () => {
                        if (caPos >= caFiles.length) {
                            return done();
                        }
                        getFile(caFiles[caPos++], (err, file) => {
                            if (!err && file) {
                                if (!ca) {
                                    ca = [];
                                }
                                ca.push(file);
                            }
                            getCaCerts();
                        });
                    };
                    getCaCerts();
                });
            });
        };

        getKeyfiles(() => {
            if (this.options.secure) {
                this.keyFiles = { key, ca, cert };

                let defaultTlsOptions = tlsOptions(
                    Object.assign({}, this.options, {
                        key: this.keyFiles.key,
                        ca: [].concat(this.keyFiles.ca || []),
                        cert: this.keyFiles.cert
                    })
                );

                this.defaultSecureContext = tls.createSecureContext(defaultTlsOptions);
            } else {
                this.keyFiles = {};
            }

            this.server = net.createServer(socket => this.connection(socket));

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
        });
    }

    close(callback) {
        this.closing = true;
        if (!this.server) {
            return setImmediate(() => callback());
        }
        this.server.close(callback);
    }
}

module.exports = SMTPProxy;
