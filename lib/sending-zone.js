'use strict';

// FIXME: If spawned child dies and never returns information about deliveries
// then we do not know how many connections are currently open, so we might end up
// in a deadlock. We also might end up in a situation where we send the same messages
// twice

const config = require('config');
const os = require('os');
const net = require('net');
const hostname = os.hostname();
const crc32 = require('crc-32');
const child_process = require('child_process');
const log = require('npmlog');
const crypto = require('crypto');
const punycode = require('punycode');

let sendingZonelist = new Map();
let recipientDomainMap = new Map();
let senderDomainMap = new Map();

/**
 * SendingZone class. Shares methods between parent instance and child sender instances
 */
class SendingZone {

    /**
     * Initializes the SendingZone instance
     *
     * @constructor
     * @param {Object} zone Zone configuration
     * @param {Object} queue MailQueue instance
     */
    constructor(zone, queue) {
        this.name = (zone.name || '').toLowerCase().trim();
        this.queue = queue;

        // child process count
        this.processes = zone.processes || 1;
        // connections per child processes
        this.connections = zone.connections || 1;
        this.pool = [].concat(zone.pool || []);

        // copy properties from the config object
        ['logger', 'logLevel'].forEach(key => {
            if (key in zone) {
                this[key] = zone[key];
            }
        });

        // Stores the count of current handlers for a specific domain
        this.domainStats = new Map();
        this.lastDomain = false;

        // If throttling is configured then calculate required parameters
        if (zone.throttling) {
            let throttlingParts = (zone.throttling || '').toString().split('/');
            this.throttling = {
                messages: Math.ceil(parseInt(throttlingParts.shift(), 10) || 0),
                time: ({
                    s: 1,
                    m: 60,
                    h: 3600
                })[throttlingParts.pop().trim().charAt(0).toLowerCase()] || 3600,
                timers: new WeakMap()
            };
            if (this.throttling.messages <= 0) {
                this.throttling = false;
            } else {
                this.throttling.minTime = (this.throttling.time * 1000) / this.throttling.messages;
            }
        }

        // If network interface is set
        if (zone.interface) {
            let ifaces = os.networkInterfaces();
            let addresses = [].concat(ifaces && ifaces[zone.interface] || []).map(iface => ({
                address: iface.address,
                name: hostname
            }));
            this.pool = this.pool.concat(addresses);
        }

        this.ipv4Pool = [].concat(this.pool || []).filter(item => net.isIPv4(item.address));
        this.ipv6Pool = [].concat(this.pool || []).filter(item => net.isIPv6(item.address));

        if (!this.ipv4Pool.length) {
            this.ipv4Pool.push({
                address: '0.0.0.0',
                name: hostname
            });
        }

        if (!this.ipv6Pool.length) {
            this.ipv6Pool.push({
                address: '::',
                name: hostname
            });
        }

        this.spawned = 0;
    }

    getAddress(key, useIPv6) {
        let pool = useIPv6 ? this.ipv6Pool : this.ipv4Pool;
        // Return the same IP for the same delivery. This is needed for greylisting
        // where the server expects request from the same source
        let index = Math.abs(crc32.str(key) % pool.length);
        return pool[index];
    }

    spawnSender() {
        if (!this.queue || this.spawned >= this.processes || this.queue.closing) {
            return false;
        }

        let childId = crypto.randomBytes(10).toString('hex');
        let child = child_process.fork('./sender.js', [this.name, this.queue.instanceId, childId]);
        let pid = child.pid;

        child.on('close', (code, signal) => {
            this.spawned--;
            if (this.queue && !this.queue.closing) {
                log.error('Child/' + this.name + '/' + pid, 'Sender process %s for %s exited with %s', childId, this.name, code || signal);
                // Check and process any unacked messages for the killed process
                this.queue.releaseUnacked('unacked-' + childId + '.' + this.name + '.' + pid + '.log', () => {
                    // Clear domain locks. These can be safely just flushed as we break throttling/etc
                    // expectations but we do not break anything (no double sending for example)
                    this.domainStats = new Map();
                    this.lastDomain = false;
                    this.queue.skipDomains = new Map();

                    // Respawn after 5 seconds
                    setTimeout(() => this.spawnSender(), 5 * 1000).unref();
                });
            }
        });

        this.spawned++;
        if (this.spawned < this.processes) {
            setImmediate(() => this.spawnSender());
        }
    }

    getNextDelivery(lockOwner, callback) {
        if (!this.queue) {
            return callback(new Error('Queue missing'));
        }
        let options = this.getDeliveryOptions();
        options.lockOwner = lockOwner;
        this.queue.shift(this.name, options, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (delivery) {
                this.deliveryStart(delivery);
            }
            return callback(null, delivery);
        });
    }

    releaseDelivery(delivery, callback) {
        if (!this.queue) {
            return callback(new Error('Queue missing'));
        }
        this.deliveryDone(delivery);
        this.queue.releaseDelivery(delivery, callback);
    }

    deferDelivery(delivery, ttl, callback) {
        if (!this.queue) {
            return callback(new Error('Queue missing'));
        }
        this.deliveryDone(delivery);
        this.queue.deferDelivery(delivery, ttl, callback);
    }

    deliveryStart(delivery) {
        let stats;
        if (!this.domainStats.has(delivery.domain)) {
            this.domainStats.set(delivery.domain, {
                deliveries: 0
            });
        }

        stats = this.domainStats.get(delivery.domain);
        stats.deliveries++;

        this.lastDomain = delivery.domain;
        if (stats.deliveries >= this.domainConfig(delivery.domain).maxConnections) {
            this.queue.skipDomain(this.name, delivery.domain);
        } else {
            this.queue.releaseDomain(this.name, delivery.domain);
        }
    }

    deliveryDone(delivery) {
        let stats;
        if (this.domainStats.has(delivery.domain)) {
            stats = this.domainStats.get(delivery.domain);
            stats.deliveries--;

            if (stats.deliveries < this.domainConfig(delivery.domain).maxConnections) {
                this.queue.releaseDomain(this.name, delivery.domain);
            }
            if (stats.deliveries < 1) {
                this.domainStats.delete(delivery.domain);
            }
        }
    }

    getDeliveryOptions() {
        let options = {};
        let stats;

        if (!this.lastDomain) {
            return options;
        }

        if (this.domainStats.has(this.lastDomain)) {
            stats = this.domainStats.get(this.lastDomain);
            if (stats.deliveries < this.domainConfig(this.lastDomain).maxConnections) {
                options.domain = this.lastDomain; // prefer the same domain for new deliveries
            }
        }

        return options;
    }

    domainConfig(domain) {
        if (config.domainConfig.hasOwnProperty(domain) && config.domainConfig[domain]) {
            return config.domainConfig[domain];
        }
        return config.domainConfig.default;
    }

    speedometer(ref, next) {
        if (!this.throttling) {
            return setImmediate(next);
        }

        if (!this.throttling.timers.has(ref)) {
            this.throttling.timers.set(ref, 0);
        }

        let curTime = Date.now();
        let timeDiff = curTime - this.throttling.timers.get(ref);

        if (timeDiff >= this.throttling.minTime) {
            this.throttling.timers.set(ref, curTime);
            return setImmediate(next);
        }
        // we hit the speedometer!
        let nextCheck = this.throttling.last + this.throttling.minTime - curTime + 1;
        //log.info('Queue', 'Speedometer for %s hit after %ss. Next check in %ss.', this.name, timeDiff / 1000, nextCheck / 1000);
        setTimeout(() => this.speedometer(ref, next), nextCheck);
    }
}

module.exports.sendingZonelist = sendingZonelist;
module.exports.SendingZone = SendingZone;

module.exports.init = queue => {
    [].concat(config.zones || []).forEach(zoneData => {
        let zone = new SendingZone(zoneData, queue);
        sendingZonelist.set(zone.name, zone);

        if (zoneData.senderDomains) {
            (Array.isArray(zoneData.senderDomains) ? zoneData.senderDomains : [zoneData.senderDomains]).forEach(domain => {
                domain = punycode.toASCII(domain.toLowerCase().trim());
                if (!senderDomainMap.has(domain)) {
                    senderDomainMap.set(domain, zone);
                }
            });
        }

        if (zoneData.recipientDomains) {
            (Array.isArray(zoneData.recipientDomains) ? zoneData.recipientDomains : [zoneData.recipientDomains]).forEach(domain => {
                domain = punycode.toASCII(domain.toLowerCase().trim());
                if (!recipientDomainMap.has(domain)) {
                    recipientDomainMap.set(domain, zone);
                }
            });
        }

        setImmediate(() => zone.spawnSender()); // start process spawning
    });
};

module.exports.get = name => {
    name = (name || '').toLowerCase().trim();
    return sendingZonelist.get(name);
};

/**
 * Maps a Sending Zone by recipient domain
 *
 * @param {String} domain Domain name to look for
 * @return {String} Sending Zone name
 */
module.exports.findByRecipient = domain => recipientDomainMap.has(domain) ? recipientDomainMap.get(domain).name : false;

/**
 * Maps a Sending Zone by sender domain
 *
 * @param {String} domain Domain name to look for
 * @return {String} Sending Zone name
 */
module.exports.findBySender = domain => senderDomainMap.has(domain) ? senderDomainMap.get(domain).name : false;
