'use strict';

// Main application file
// Run as 'node app.js' to start

const config = require('config');
const log = require('npmlog');
log.level = config.log.level;
require('./lib/logger');

// do not pass node args to children (--inspect, --max-old-space-size etc.)
process.execArgv = [];

const SMTPProxy = require('./lib/receiver/smtp-proxy');
const QueueServer = require('./lib/queue-server');
const senders = require('./lib/sender/senders');
const packageData = require('./package.json');

process.title = config.ident + ': master process';

log.info('ZoneMTA', ' _____             _____ _____ _____ ');
log.info('ZoneMTA', '|__   |___ ___ ___|     |_   _|  _  |');
log.info('ZoneMTA', '|   __| . |   | -_| | | | | | |     |');
log.info('ZoneMTA', '|_____|___|_|_|___|_|_|_| |_| |__|__|');
log.info('ZoneMTA', '            --- v' + packageData.version + ' ---');

const smtpInterfaces = [];
const queueServer = new QueueServer();

let startSMTPInterfaces = done => {
    let keys = Object.keys(config.smtpInterfaces || {}).filter(key => config.smtpInterfaces[key].enabled);
    let pos = 0;
    let startNext = () => {
        if (pos >= keys.length) {
            return done();
        }
        let key = keys[pos++];
        let smtpProxy = new SMTPProxy(key, config.smtpInterfaces[key]);
        smtpProxy.start(err => {
            if (err) {
                log.error('SMTP/' + smtpProxy.interface, 'Could not start ' + key + ' MTA server');
                log.error('SMTP/' + smtpProxy.interface, err);
                return done(err);
            }
            log.info('SMTP/' + smtpProxy.interface, 'SMTP ' + key + ' MTA server started listening on port %s', config.smtpInterfaces[key].port);
            smtpInterfaces.push(smtpProxy);
            return startNext();
        });
    };
    startNext();
};

// Starts the queueing MTA
startSMTPInterfaces(err => {
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

        // start sending processes
        senders.init();

        // spawn SMTP servers
        smtpInterfaces.forEach(smtpProxy => smtpProxy.spawnReceiver());
    });
});


let forceStop = code => {
    log.info('Process', 'Force closing...');
    setTimeout(() => process.exit(code), 10);
    return;
};

let stop = code => {
    code = code || 0;
    log.info('Process', 'Server closing down...');

    let closed = 0;
    let checkClosed = () => {
        if (++closed >= 1 + smtpInterfaces.length) {
            process.exit(code);
        }
    };

    senders.close();

    // Stop accepting any new connections
    smtpInterfaces.forEach(smtpInterface => smtpInterface.close(() => {
        // wait until all connections to the SMTP server are closed
        log.info(smtpInterface.logName, 'Service closed');
        checkClosed();
    }));

    queueServer.close(() => {
        // wait until all connections to the API HTTP are closed
        log.info('QS', 'Service closed');
        checkClosed();
    });

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
