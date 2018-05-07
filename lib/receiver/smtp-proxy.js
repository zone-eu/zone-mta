'use strict';

const config = require('wild-config');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const log = require('npmlog');
const crypto = require('crypto');
const child_process = require('child_process');

class SMTPProxy {
    constructor(smtpInterface, options) {
        this.name = smtpInterface;
        this.options = options || {};
        this.children = new Set();
        this.processes = this.options.processes || 1;
        this.selector = false;

        this.interface = smtpInterface;

        this.keyFiles = false;

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
                log.error('SMTP/' + this.name + '/' + pid, 'Reciver process %s for %s exited with %s', childId, this.name, code || signal);

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

        // we have a TLS client on the line, upgrade connection and return error message
        let socketOptions = {
            isServer: true,
            key: this.keyFiles.key,
            cert: this.keyFiles.cert
        };

        // remove all listeners from the original socket besides the error handler
        socket.removeAllListeners();
        socket.on('error', err => {
            log.error('SMTP/' + this.name, 'Failed setting up TLS. %s', err.message);
        });

        // upgrade connection
        let secureSocket = new tls.TLSSocket(this._socket, socketOptions);

        secureSocket.on('close', () => false);
        secureSocket.on('error', err => {
            log.error('SMTP/' + this.name, 'Failed setting up TLS. %s', err.message);
        });

        secureSocket.on('clientError', err => {
            log.error('SMTP/' + this.name, 'Failed setting up TLS. %s', err.message);
        });

        secureSocket.on('secure', () => {
            socket = secureSocket;
            try {
                socket.end(message + '\r\n');
            } catch (E) {
                // ignore, probably socket already closed
            }
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
        child.send('socket', socket);
    }

    start(callback) {
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

        getKeyfiles(() => {
            this.keyFiles = this.options.secure ? { key, cert } : {};
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
