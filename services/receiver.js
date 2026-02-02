'use strict';

// NB! This script is ran as a separate process

const argv = require('minimist')(process.argv.slice(2));
const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const crypto = require('crypto');
const { gelfCode, emitGelf } = require('../lib/log-gelf');
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
let clientId = argv.interfaceId || crypto.randomBytes(10).toString('hex');
let smtpServer = false;

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
                _pid: process.pid
            });
            process.exit(1);
        }
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
    if (m === 'socket') {
        if (!socket) {
            log.verbose('SMTP/' + currentInterface + '/' + process.pid, 'Null Socket');
            return;
        }

        let passSocket = () =>
            smtpServer.server._handleProxy(socket, (proxyErr, socketOptions) => {
                smtpServer.server.connect(socket, socketOptions);
            });

        if (!smtpServer || !smtpServer.server) {
            let tryCount = 0;
            let nextTry = () => {
                if (smtpServer && smtpServer.server) {
                    return passSocket();
                }
                if (tryCount++ > 5) {
                    try {
                        return socket.end('421 Process not yet initialized\r\n');
                    } catch (E) {
                        // ignore
                    }
                } else {
                    return setTimeout(nextTry, 100 * tryCount).unref();
                }
            };
            return setTimeout(nextTry, 100).unref();
        }

        return passSocket();
    }
});
