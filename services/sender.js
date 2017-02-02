'use strict';

// NB! This script is ran as a separate process, so no direct access to the queue, no data
// sharing with other part of the code etc.

const config = require('config');
const log = require('npmlog');

// initialize plugin system
const plugins = require('../lib/plugins');
plugins.init('sender');

const Sender = require('../lib/sender/sender');
const SendingZone = require('../lib/sender/sending-zone');
const crypto = require('crypto');

const RemoteClient = require('../lib/transport/client');
const SubscribeQueue = require('../lib/sender/subscribe-queue');

let zone;

// Read command line arguments
let currentZone = (process.argv[2] || '').toString().trim().toLowerCase();
let clientId = (process.argv[3] || '').toString().trim().toLowerCase() || crypto.randomBytes(10).toString('hex');

// Find and setup correct Sending Zone
Object.keys(config.zones || {}).find(zoneName => {
    let zoneData = config.zones[zoneName];
    if (zoneName === currentZone) {
        zone = new SendingZone(zoneName, zoneData, false);
        return true;
    }
    return false;
});

if (!zone) {
    require('../lib/logger'); // eslint-disable-line global-require
    log.error('Sender/' + process.pid, 'Unknown Zone %s', currentZone);
    return process.exit(5);
}

let logName = 'Sender/' + zone.name + '/' + process.pid;
log.level = 'logLevel' in zone ? zone.logLevel : config.log.level;
require('../lib/logger'); // eslint-disable-line global-require
log.info(logName, '[%s] Starting sending for %s', clientId, zone.name);

process.title = config.ident + ': sender/' + currentZone;

// Set up remote connection to master process
// If this connection breaks, then we'll close the process as well
const remoteClient = RemoteClient.createClient(config.queueServer);
remoteClient.connect(err => {
    if (err) {
        log.error(logName, 'Could not connect to Queue server. %s', err.message);
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
    remoteClient.send({
        cmd: 'HELLO',
        zone: zone.name,
        id: clientId
    });

    let queue = new SubscribeQueue();
    queue.init(remoteClient, err => {
        if (err) {
            log.error(logName, 'Queue error %s', err.message);
            return process.exit(1);
        }

        plugins.handler.queue = queue;

        plugins.handler.load(() => {
            log.info(logName, '%s plugins loaded', plugins.handler.loaded.length);
        });

        // start sending instances
        console.log('CREATE %s SENDER PROCESSES FOR %s', zone.connections, zone.name);

        let sender = new Sender(clientId, zone, queue, remoteClient);
        sender.once('error', err => {
            log.info(logName, 'Sender error. %s', err.message);
            sender.removeAllListeners('error');
            sender.close();
        });
    });
});
