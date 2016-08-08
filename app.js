'use strict';

// Main application file
// Run as 'node app.js' to start

const config = require('config');
const log = require('npmlog');
const createFeederServer = require('./lib/feeder-server');
const createAPIServer = require('./lib/api-server');
const createMailQueue = require('./lib/mail-queue');
const sendingZone = require('./lib/sending-zone');

log.level = config.log.level;
process.title = 'zone-mta: master process';

let feederServer = createFeederServer();
let apiServer = createAPIServer();
let queue = createMailQueue(config.queue);

// Starts the queueing MTA
feederServer.start(err => {
    if (err) {
        log.error('Feeder', 'Could not start feeder MTA server');
        log.error('Feeder', err);
        return process.exit(1);
    }
    log.info('Feeder', 'Feeder MTA server started');

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
                log.info('Service', 'Failed to change group to "%s" (%s)', config.group, E.message);
            }
        }
        if (config.user) {
            try {
                process.setuid(config.user);
                log.info('Service', 'Changed user to "%s" (%s)', config.user, process.getuid());
            } catch (E) {
                log.info('Service', 'Failed to change user to "%s" (%s)', config.user, E.message);
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

            feederServer.queue = queue;
            apiServer.queue = queue;
            sendingZone.init(queue);
        });
    });
});

let stop = code => {
    code = code || 0;
    if (queue.closing) {
        log.info('Process', 'Force closing...');
        return process.exit(code);
    }
    log.info('Process', 'Server closing down...');
    queue.closing = true;

    let closed = 0;
    let checkClosed = () => {
        if (++closed === 3) {
            queue.db.close(() => process.exit(code));
        }
    };

    // Stop accepting any new connections
    feederServer.close(() => {
        // wait until all connections to the feeder SMTP are closed
        log.info('Feeder', 'Service closed');
        checkClosed();
    });
    apiServer.close(() => {
        // wait until all connections to the API HTTP are closed
        log.info('API', 'Service closed');
        checkClosed();
    });
    queue.stop(() => {
        // wait until DB is closed
        log.info('Queue', 'Service closed');
        checkClosed();
    });

    // If we were not able to stop other stuff by 10 sec. force close
    let forceExitTimer = setTimeout(() => {
        log.info('Process', 'Timed out, force closing...');
        process.exit(code);
    }, 10 * 1000);
    forceExitTimer.unref();
};

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

process.on('uncaughtException', err => {
    log.error('Process', 'Uncaught exception');
    log.error('Process', err);
    stop(4);
});
