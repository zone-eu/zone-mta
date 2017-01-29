'use strict';

// Main application file
// Run as 'node app.js' to start

const config = require('config');
const log = require('npmlog');
log.level = config.log.level;
require('./lib/logger');

// do not pass node args to children (--inspect, --max-old-space-size etc.)
process.execArgv = [];

const SMTPInterface = require('./lib/smtp-interface');
const APIServer = require('./lib/api-server');
const QueueServer = require('./lib/queue-server');
const MailQueue = require('./lib/mail-queue');
const sendingZone = require('./lib/sending-zone');
const plugins = require('./lib/plugins');
const packageData = require('./package.json');
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;

process.title = config.ident + ': master process';

log.info('ZoneMTA', ' _____             _____ _____ _____ ');
log.info('ZoneMTA', '|__   |___ ___ ___|     |_   _|  _  |');
log.info('ZoneMTA', '|   __| . |   | -_| | | | | | |     |');
log.info('ZoneMTA', '|_____|___|_|_|___|_|_|_| |_| |__|__|');
log.info('ZoneMTA', '            --- v' + packageData.version + ' ---');

const smtpInterfaces = [];
const apiServer = new APIServer();
const queueServer = new QueueServer();
const queue = new MailQueue(config.queue);

plugins.init('main');

let startSMTPInterfaces = (mongodb, done) => {
    let keys = Object.keys(config.smtpInterfaces || {}).filter(key => config.smtpInterfaces[key].enabled);
    let pos = 0;
    let startNext = () => {
        if (pos >= keys.length) {
            return done();
        }
        let key = keys[pos++];
        let smtp = new SMTPInterface(key, config.smtpInterfaces[key], mongodb);
        smtp.start(err => {
            if (err) {
                log.error('SMTP/' + smtp.interface, 'Could not start ' + key + ' MTA server');
                log.error('SMTP/' + smtp.interface, err);
                return done(err);
            }
            log.info('SMTP/' + smtp.interface, 'SMTP ' + key + ' MTA server started listening on port %s', config.smtpInterfaces[key].port);
            smtpInterfaces.push(smtp);
            return startNext();
        });
    };
    startNext();
};

MongoClient.connect(config.queue.mongodb, (err, mongodb) => {
    if (err) {
        log.error('Queue', 'Could not initialize MongoDB: %s', err.message);
        return process.exit(2);
    }

    // Starts the queueing MTA
    startSMTPInterfaces(mongodb, err => {
        if (err) {
            return process.exit(1);
        }
        queueServer.start(err => {
            if (err) {
                log.error('QS', 'Could not start Queue server');
                log.error('QS', err);
                return process.exit(2);
            }
            log.info('QS', 'Queue server started');

            // Starts the API HTTP REST server that is used by sending processes to fetch messages from the queue
            apiServer.start(err => {
                if (err) {
                    log.error('API', 'Could not start API server');
                    log.error('API', err);
                    return process.exit(2);
                }
                log.info('API', 'API server started');

                // downgrade user if needed
                if (config.group) {
                    try {
                        process.setgid(config.group);
                        log.info('Service', 'Changed group to "%s" (%s)', config.group, process.getgid());
                    } catch (E) {
                        log.error('Service', 'Failed to change group to "%s" (%s)', config.group, E.message);
                        return process.exit(1);
                    }
                }
                if (config.user) {
                    try {
                        process.setuid(config.user);
                        log.info('Service', 'Changed user to "%s" (%s)', config.user, process.getuid());
                    } catch (E) {
                        log.error('Service', 'Failed to change user to "%s" (%s)', config.user, E.message);
                        return process.exit(1);
                    }
                }

                // Open LevelDB database and start sender processes
                queue.init(err => {
                    if (err) {
                        log.error('Queue', 'Could not initialize sending queue');
                        log.error('Queue', err);
                        return process.exit(3);
                    }
                    log.info('Queue', 'Sending queue initialized');

                    apiServer.setQueue(queue);
                    queueServer.setQueue(queue);
                    sendingZone.init(queue);

                    // spawn SMTP servers
                    smtpInterfaces.forEach(smtp => smtp.spawnReceiver());

                    plugins.handler.queue = queue;
                    plugins.handler.apiServer = apiServer;
                    plugins.handler.load(() => {
                        log.info('Plugins', 'Plugins loaded');
                    });
                });
            });
        });
    });
});

let forceStop = code => {
    log.info('Process', 'Force closing...');
    try {
        queue.db.close(() => false);
    } catch (E) {
        // ignore
    }
    setTimeout(() => process.exit(code), 10);
    return;
};

let stop = code => {
    code = code || 0;
    if (queue.closing) {
        return forceStop(code);
    }
    log.info('Process', 'Server closing down...');
    queue.closing = true;

    let closed = 0;
    let checkClosed = () => {
        if (++closed === 2 + smtpInterfaces.length) {
            if (queue.db) {
                queue.db.close(() => process.exit(code));
            } else {
                process.exit(code);
            }
        }
    };

    // Stop accepting any new connections
    smtpInterfaces.forEach(smtpInterface => smtpInterface.close(() => {
        // wait until all connections to the SMTP server are closed
        log.info(smtpInterface.logName, 'Service closed');
        checkClosed();
    }));

    apiServer.close(() => {
        // wait until all connections to the API HTTP are closed
        log.info('API', 'Service closed');
        checkClosed();
    });

    queueServer.close(() => {
        // wait until all connections to the API HTTP are closed
        log.info('QS', 'Service closed');
        checkClosed();
    });
    queue.stop();

    // If we were not able to stop other stuff by 10 sec. force close
    let forceExitTimer = setTimeout(() => forceStop(code), 10 * 1000);
    forceExitTimer.unref();
};

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

process.on('uncaughtException', err => {
    log.error('Process', 'Uncaught exception');
    log.error('Process', err);
    stop(4);
});
