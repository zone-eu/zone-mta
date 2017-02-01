'use strict';

const config = require('config');
const child_process = require('child_process');
const log = require('npmlog');
const crypto = require('crypto');

let closing = false;

let createZone = (zoneName, zoneData) => {
    let spawned = 0;
    let processes = zoneData.processes || 1;
    let spawnSender = () => {

        if (spawned >= processes || zoneData.disabled) {
            return false;
        }

        let childId = crypto.randomBytes(10).toString('hex');
        let child = child_process.fork(__dirname + '/../../services/sender.js', [zoneName, childId]);
        let pid = child.pid;

        child.on('close', (code, signal) => {
            spawned--;
            if (!closing) {
                log.error('Child/' + zoneName + '/' + pid, 'Sender process %s for %s exited with %s', childId, zoneName, code || signal);
                // Respawn after 5 seconds
                setTimeout(() => spawnSender(), 5 * 1000).unref();
            }
        });

        spawned++;
        if (spawned < processes) {
            setImmediate(() => spawnSender());
        }
    };

    spawnSender();
};

module.exports.init = () => {
    Object.keys(config.zones || {}).forEach(zoneName => {
        let zoneData = config.zones[zoneName];
        if (!zoneData || zoneData.disabled) {
            return;
        }
        setImmediate(() => createZone(zoneName, zoneData)); // start process spawning
    });
};

module.exports.close = () => {
    closing = true;
};
