'use strict';

// NB! This script is started as a separate process

const config = require('config');
const log = require('npmlog');
const crypto = require('crypto');

log.level = config.log.level;
require('../lib/logger');

// initialize plugin system
const plugins = require('../lib/plugins');
plugins.init('receiver');

const RemoteClient = require('../lib/transport/client');
const PublishQueue = require('../lib/receiver/publish-queue');
const SMTPInterface = require('../lib/receiver/smtp-interface');

let interfaceName = (process.argv[2] || '').toString().trim().toLowerCase();
let clientId = (process.argv[3] || '').toString().trim().toLowerCase() || crypto.randomBytes(10).toString('hex');
let logName = 'SMTP/' + interfaceName + '/' + process.pid;
let smtpServer = false;

process.title = config.ident + ': receiver/' + interfaceName;

// Set up remote connection to master process
// If this connection breaks, then we'll close the process as well
const remoteClient = RemoteClient.createClient(config.queueServer);
remoteClient.connect(err => {
    if (err) {
        log.error(logName, 'Could not connect to Queue server');
        log.error(logName, err.message);
        process.exit(1);
    }

    remoteClient.on('close', () => {
        log.info(logName, 'Connection to Queue server closed');
        process.exit(1);
    });

    remoteClient.on('error', err => {
        log.error(logName, 'Connection to Queue server ended with error %s', err.message);
        process.exit(1);
    });

    // Notify the server about the details of this client
    remoteClient.sendCommand({
        cmd: 'HELLO',
        smtp: interfaceName,
        id: clientId
    });

    let queue = new PublishQueue();
    queue.init(remoteClient, err => {
        if (err) {
            log.error(logName, 'Queue error %s', err.message);
            return process.exit(1);
        }

        plugins.handler.load(() => {
            log.info(logName, '%s plugins loaded', plugins.handler.loaded.length);
        });

        smtpServer = new SMTPInterface(interfaceName, config.smtpInterfaces[interfaceName], queue, remoteClient);
        smtpServer.setup(err => {
            if (err) {
                log.error(logName, 'Could not start ' + interfaceName + ' MTA server');
                log.error(logName, err);
                return process.exit(1);
            }
            log.info(logName, 'SMTP ' + interfaceName + ' MTA server started');
        });
    });
});

// start accepting sockets
process.on('message', (m, socket) => {
    if (m === 'socket') {
        if (!smtpServer || !smtpServer.server) {
            // we don't have a SMTP server set up yet
            let tryCount = 0;
            let nextTry = () => {
                if (smtpServer && smtpServer.server) {
                    return smtpServer.server.connect(socket);
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
        // pass the socket received from proxy master to the SMTP server instance
        smtpServer.server.connect(socket);
    }
});
