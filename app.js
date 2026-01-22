/* eslint-disable global-require */
'use strict';

/*
 * FIXME: Restify depends on `spdy`, which in turn depends on `http-deceiver`,
 * which uses the legacy C library `http_parser`.
 *
 * Newer versions of Node.js have removed `http_parser` in favor of
 * modern APIs. Unfortunately:
 *   - `http-deceiver` was last updated ~9 years ago,
 *   - `spdy` ~5 years ago,
 *   - Restify itself ~2 years ago.
 *
 * As a result, these outdated libraries haven’t been replaced.
 *
 * Quick fix: polyfill `http_parser`.
 * Possible Long-term fix: fork Restify and remove/replace the outdated deps.
 */
const originalBinding = process.binding;
process.binding = function (name) {
    if (name === 'http_parser') {
        return require('http-parser-js');
    }
    return originalBinding.call(process, name);
};

// Main application file
// Run as 'node app.js' to start
const path = require('path');
process.env.NODE_CONFIG_DIR = path.join(__dirname, '.', 'config');
const config = require('@zone-eu/wild-config');

if (process.env.NODE_CONFIG_ONLY === 'true') {
    console.log(require('util').inspect(config, false, 22)); // eslint-disable-line
    return process.exit();
}

const fs = require('fs');
const os = require('os');
const util = require('util');
const Gelf = require('gelf');
const log = require('npmlog');
log.level = config.log.level;

const gelfConfig = (config.log && config.log.gelf) || {};
const component = gelfConfig.component || 'mta';
const hostname = gelfConfig.hostname || os.hostname();
const gelfEnabled = !!(gelfConfig && gelfConfig.enabled);
const gelf = gelfEnabled ? new Gelf(gelfConfig.options) : null;

const loggelf = (message, requiredKeys = []) => {
    if (typeof message === 'string') {
        message = {
            short_message: message
        };
    }
    message = message || {};

    if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
        message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
    }

    message.facility = component;
    message.host = hostname;
    message.timestamp = Date.now() / 1000;
    message._component = component;
    Object.keys(message).forEach(key => {
        if (!message[key] && !requiredKeys.includes(key)) {
            // remove the key if it empty/falsy/undefined/null and it is not required to stay
            delete message[key];
        }
    });
    if (gelf) {
        gelf.emit('gelf.log', message);
    }
};

const originalLogError = log.error.bind(log);
log.error = (...args) => {
    originalLogError(...args);

    if (!gelfEnabled) {
        return;
    }

    const hasPrefix = typeof args[0] === 'string';
    const logPrefix = hasPrefix ? args[0] : '';
    const messageArgs = hasPrefix ? args.slice(1) : args;
    const error = messageArgs.find(arg => arg instanceof Error);

    let formattedMessage = '';
    if (messageArgs.length) {
        if (messageArgs.length === 1 && error) {
            formattedMessage = error.message || error.toString();
        } else {
            const safeArgs = messageArgs.map(arg => (arg instanceof Error ? arg.message || arg.toString() : arg));
            formattedMessage = util.format(...safeArgs);
        }
    }

    const shortMessage = [logPrefix, formattedMessage].filter(Boolean).join(' ');
    loggelf(
        {
            short_message: shortMessage || (error && (error.message || error.toString())) || logPrefix || 'Error',
            full_message: error && error.stack ? error.stack : undefined,
            _logger: logPrefix
        },
        ['short_message']
    );
};

// do not pass node args to children (--inspect, --max-old-space-size etc.)
process.execArgv = [];

const promClient = require('prom-client'); // eslint-disable-line no-unused-vars

const SMTPProxy = require('./lib/receiver/smtp-proxy');
const APIServer = require('./lib/api-server');
const QueueServer = require('./lib/queue-server');
const MailQueue = require('./lib/mail-queue');
const sendingZone = require('./lib/sending-zone');
const plugins = require('./lib/plugins');
const packageData = require('./package.json');

process.title = config.ident + ': master process';

printLogo();

const smtpInterfaces = [];
const apiServer = new APIServer();
const queueServer = new QueueServer();
const queue = new MailQueue(config.queue);

promClient.collectDefaultMetrics({ timeout: 5000 });

config.on('reload', () => {
    queue.cache.flush();
    log.info('APP', 'Configuration reloaded');
});

plugins.init('main');

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

        // Starts the API HTTP REST server that is used by sending processes to fetch messages from the queue
        apiServer.start(err => {
            if (err) {
                log.error('API', 'Could not start API server');
                log.error('API', err);
                return process.exit(2);
            }
            log.info('API', 'API server started listening on port %s', config.api.port);

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

            queue.init(err => {
                if (err) {
                    log.error('Queue', 'Could not initialize sending queue');
                    log.error('Queue', err);
                    return process.exit(3);
                }
                log.info('Queue', 'Sending queue initialized');

                apiServer.setQueue(queue);
                queueServer.setQueue(queue);

                // spawn SMTP server interfaces
                smtpInterfaces.forEach(smtp => smtp.spawnReceiver());

                // spawn sending zones
                sendingZone.init(queue, () => {
                    plugins.handler.queue = queue;
                    plugins.handler.apiServer = apiServer;
                    plugins.handler.load(() => {
                        log.verbose('Plugins', 'Plugins loaded');
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
    smtpInterfaces.forEach(smtpInterface =>
        smtpInterface.close(() => {
            // wait until all connections to the SMTP server are closed
            log.info(smtpInterface.logName, 'Service closed');
            checkClosed();
        })
    );

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

function printLogo() {
    let logo = fs
        .readFileSync(__dirname + '/logo.txt', 'utf-8')
        .replace(/^\n+|\n+$/g, '')
        .split('\n');

    let columnLength = logo.map(l => l.length).reduce((max, val) => (val > max ? val : max), 0);
    let versionString = ' ' + packageData.name + '@' + packageData.version + ' ';
    let versionPrefix = '-'.repeat(Math.round(columnLength / 2 - versionString.length / 2));
    let versionSuffix = '-'.repeat(columnLength - versionPrefix.length - versionString.length);

    log.info('App', ' ' + '-'.repeat(columnLength));
    log.info('App', '');

    logo.forEach(line => {
        log.info('App', ' ' + line);
    });

    log.info('App', '');

    log.info('App', ' ' + versionPrefix + versionString + versionSuffix);
    log.info('App', '');
}
