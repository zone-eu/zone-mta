'use strict';

// NB! This script is ran as a separate process

const argv = require('minimist')(process.argv.slice(2));
const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const crypto = require('crypto');
const { gelfCode, emitGelf } = require('../lib/log-gelf');
const { logSmtpReject } = require('../lib/log-smtp');
require('../lib/log-setup')(config);

log.level = config.log.level;

// initialize plugin system
const plugins = require('../lib/plugins');
plugins.init('receiver');

const SMTPInterface = require('../lib/smtp-interface');

const QueueClient = require('../lib/transport/client');
const queueClient = new QueueClient(config.queueServer);
const RemoteQueue = require('../lib/remote-queue');

let currentInterface = argv.interfaceName;
let logName = 'SMTP/' + currentInterface + '/' + process.pid;
let clientId = argv.interfaceId || crypto.randomBytes(10).toString('hex');
let smtpServer = false;
let pendingSockets = new Set();

// Sockets that were handed over by the master but can not be served. Answer with a temporary
// error like the master does for its own sockets instead of resetting the connection, so the
// remote side knows it can retry later.
let closeSocket = (socket, message) => {
    if (!socket) {
        return;
    }

    // A reset peer surfaces as an asynchronous 'error' on the socket, not a synchronous
    // throw, so neither the try/catch below nor socket.destroy() stops it from becoming an
    // unhandled 'error' that crashes the worker process. Attach a no-op handler up front.
    socket.on('error', () => {
        // ignore, the connection is being refused anyway
    });

    // The socket never reaches the SMTP server, so nothing else records the refusal. A secure
    // interface can not answer in plaintext and resets below, the refusal is logged either way.
    logSmtpReject(logName, socket, message);

    if (config.smtpInterfaces[currentInterface] && config.smtpInterfaces[currentInterface].secure) {
        // the client is waiting for a TLS handshake and would not understand a plaintext
        // response, and upgrading just to say goodbye is not worth it
        return socket.destroy();
    }
    try {
        socket.end(message + '\r\n');
    } catch (E) {
        socket.destroy();
    }
};

let cmdId = 0;
let responseHandlers = new Map();
let closing = false;

process.title = config.ident + ': receiver/' + currentInterface;

config.on('reload', () => {
    log.info('SMTP/' + currentInterface + '/' + process.pid, '[%s] Configuration reloaded', clientId);
});

let sendCommand = (cmd, callback) => {
    let id = ++cmdId;
    let data = {
        req: id
    };

    if (typeof cmd === 'string') {
        cmd = {
            cmd
        };
    }

    Object.keys(cmd).forEach(key => (data[key] = cmd[key]));
    responseHandlers.set(id, callback);
    queueClient.send(data);
};

let startSMTPInterface = (key, done) => {
    let smtp = new SMTPInterface(key, config.smtpInterfaces[key], sendCommand);
    smtp.setup(err => {
        if (err) {
            log.error(smtp.logName, 'Could not start ' + key + ' MTA server');
            emitGelf({
                short_message: `${gelfCode('SMTP_RECEIVER_START_FAILED')} Failed to start SMTP interface`,
                full_message: err && err.stack ? err.stack : undefined,
                _error: err.message,
                _logger: smtp.logName,
                _smtp_key: key,
                _interface: currentInterface,
                _pid: process.pid
            });
            log.error(smtp.logName, err);
            return done(err);
        }
        log.info(smtp.logName, 'SMTP ' + key + ' MTA server started');
        return done(null, smtp);
    });
};

queueClient.connect(err => {
    if (err) {
        log.error('SMTP/' + currentInterface + '/' + process.pid, 'Could not connect to Queue server');
        emitGelf({
            short_message: `${gelfCode('QUEUE_CONNECT_FAILED')} Could not connect to queue server`,
            full_message: err && err.stack ? err.stack : undefined,
            _error: err.message,
            _logger: 'SMTP/' + currentInterface + '/' + process.pid,
            _interface: currentInterface,
            _pid: process.pid,
            _queue_host: config.queueServer && (config.queueServer.host || config.queueServer.hostname),
            _queue_port: config.queueServer && config.queueServer.port
        });
        log.error('SMTP/' + currentInterface + '/' + process.pid, err.message);
        process.exit(1);
    }

    queueClient.on('close', () => {
        if (!closing) {
            log.error('SMTP/' + currentInterface + '/' + process.pid, 'Connection to Queue server closed unexpectedly');
            emitGelf({
                short_message: `${gelfCode('QUEUE_CONNECTION_CLOSED')} Queue server connection closed unexpectedly`,
                _logger: 'SMTP/' + currentInterface + '/' + process.pid,
                _interface: currentInterface,
                _pid: process.pid,
                full_message: 'Queue server connection closed unexpectedly',
                _error: 'Queue server connection closed unexpectedly'
            });
            process.exit(1);
        }

        // Shutting down already. The master only closes the queue server once this process
        // has exited, so it gave up waiting and force closed. Nothing can be reported back to
        // the queue any more, exit instead of lingering on as an orphan.
        log.info('SMTP/' + currentInterface + '/' + process.pid, 'Connection to Queue server closed, exiting');
        process.exit(0);
    });

    queueClient.on('error', err => {
        if (!closing) {
            log.error('SMTP/' + currentInterface + '/' + process.pid, 'Connection to Queue server ended with error %s', err.message);
            emitGelf({
                short_message: `${gelfCode('QUEUE_CONNECTION_ERROR')} Queue server connection error`,
                full_message: err && err.stack ? err.stack : undefined,
                _logger: 'SMTP/' + currentInterface + '/' + process.pid,
                _interface: currentInterface,
                _pid: process.pid,
                _error: err.message
            });
            process.exit(1);
        }
    });

    queueClient.onData = (data, next) => {
        let callback;
        if (responseHandlers.has(data.req)) {
            callback = responseHandlers.get(data.req);
            responseHandlers.delete(data.req);
            setImmediate(() => callback(data.error ? data.error : null, !data.error && data.response));
        }
        next();
    };

    // Notify the server about the details of this client
    queueClient.send({
        cmd: 'HELLO',
        smtp: currentInterface,
        id: clientId
    });

    let queue = new RemoteQueue();
    queue.init(sendCommand, err => {
        if (err) {
            log.error('SMTP/' + currentInterface + '/' + process.pid, 'Queue error %s', err.message);
            emitGelf({
                short_message: `${gelfCode('QUEUE_ERROR')} Queue error`,
                full_message: err && err.stack ? err.stack : undefined,
                _logger: 'SMTP/' + currentInterface + '/' + process.pid,
                _interface: currentInterface,
                _pid: process.pid,
                _error: err.message
            });
            return process.exit(1);
        }

        plugins.handler.queue = queue;

        plugins.handler.load(() => {
            log.info('SMTP/' + currentInterface + '/' + process.pid, '%s plugins loaded', plugins.handler.loaded.length);
        });

        startSMTPInterface(currentInterface, (err, smtp) => {
            if (err) {
                log.error('SMTP/' + currentInterface + '/' + process.pid, 'SMTP error %s', err.message);
                emitGelf({
                    short_message: `${gelfCode('SMTP_ERROR')} SMTP server error`,
                    full_message: err && err.stack ? err.stack : undefined,
                    _logger: 'SMTP/' + currentInterface + '/' + process.pid,
                    _interface: currentInterface,
                    _pid: process.pid,
                    _error: err.message
                });
                return process.exit(1);
            }
            smtpServer = smtp;
        });
    });
});

// start accepting sockets
process.on('message', (m, socket) => {
    if (m && m.shutdown) {
        // The master (lib/receiver/smtp-proxy.js closeChildren()) sends this over the fork IPC
        // channel when the whole server is stopping, since only the master receives SIGTERM/
        // SIGINT directly. Setting `closing` here makes the queue-connection 'close' handler
        // above treat the impending socket close as expected instead of logging it as an error.
        if (closing) {
            return;
        }
        closing = true;

        // Sockets already handed to this process but not yet promoted to an SMTP session
        // are not in smtp-server's connections Set. They cannot be drained reliably, so
        // close them before deciding whether the worker is idle.
        pendingSockets.forEach(pending => closeSocket(pending, '421 Server shutting down'));
        pendingSockets.clear();

        if (!smtpServer) {
            return process.exit(0);
        }

        log.info('SMTP/' + currentInterface + '/' + process.pid, 'Received shutdown from master, draining SMTP sessions');
        // close() sets `closing` on the interface before draining, which makes it reject
        // new connections and new mail transactions on the sessions that are still open.
        return smtpServer.close(() => {
            log.info('SMTP/' + currentInterface + '/' + process.pid, 'Graceful shutdown, draining complete, exiting');
            process.exit(0);
        });
    }

    if (m === 'socket') {
        // The parent closes its listening socket before sending the shutdown message, but
        // reject any handle that was already queued behind that message instead of starting
        // a new SMTP session while the existing ones are draining.
        if (closing) {
            return closeSocket(socket, '421 Server shutting down');
        }

        if (!socket) {
            log.verbose('SMTP/' + currentInterface + '/' + process.pid, 'Null Socket');
            return;
        }

        pendingSockets.add(socket);
        // _handleProxy() does not always run its callback, eg. when the PROXY header is
        // invalid or the peer disconnects before sending a complete one, so release the
        // reference when the socket itself goes away.
        socket.once('close', () => pendingSockets.delete(socket));
        // Guard the socket until smtp-server takes it over. If the peer resets while the
        // worker is still initializing (the retry loop below) the socket has no 'error'
        // listener yet, and an unhandled 'error' would crash the worker.
        socket.on('error', () => {
            // ignore — smtp-server attaches its own handlers once it owns the socket
        });

        let passSocket = () =>
            smtpServer.server._handleProxy(socket, (proxyErr, socketOptions) => {
                pendingSockets.delete(socket);
                if (proxyErr) {
                    return socket.destroy();
                }
                if (closing) {
                    return closeSocket(socket, '421 Server shutting down');
                }
                smtpServer.server.connect(socket, socketOptions);
            });

        if (!smtpServer || !smtpServer.server) {
            let tryCount = 0;
            let nextTry = () => {
                if (smtpServer && smtpServer.server) {
                    return passSocket();
                }
                if (tryCount++ > 5) {
                    pendingSockets.delete(socket);
                    return closeSocket(socket, '421 Process not yet initialized');
                } else {
                    return setTimeout(nextTry, 100 * tryCount).unref();
                }
            };
            return setTimeout(nextTry, 100).unref();
        }

        return passSocket();
    }
});
