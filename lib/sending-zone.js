'use strict';

const config = require('wild-config');
const os = require('os');
const net = require('net');
const dns = require('dns');
const hostname = os.hostname();
const crc32 = require('crc-32');
const child_process = require('child_process');
const log = require('npmlog');
const crypto = require('crypto');
const punycode = require('punycode');
const addressTools = require('./address-tools');

let sendingZonelist = new Map();
let recipientDomainMap = new Map();
let senderDomainMap = new Map();
let routingHeaders = new Map();
let originMap = new Map();

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
    constructor(name, zone, domainConfig, queue) {
        this.name = (name || '').toLowerCase().trim();
        this.queue = queue;

        this.domainConfig = domainConfig;
        this.children = new Set();

        this.update(zone);

        config.on('reload', () => {
            this.children.forEach(child => {
                try {
                    child.kill('SIGHUP');
                } catch (E) {
                    //ignore
                }
            });
        });
    }

    update(zone) {
        // child process count
        this.processes = zone.processes || 1;
        // connections per child processes
        this.connections = zone.connections || 1;

        let pool = zone.pool;
        if (typeof zone.pool === 'string' && config.pools[zone.pool]) {
            pool = config.pools[zone.pool];
        }
        this.pool = [].concat(pool || []).map(item => {
            if (typeof item === 'string') {
                return {
                    address: item
                };
            }
            return item;
        });

        // copy properties from the config object
        [
            'logger',
            'logLevel',
            'resolveIp',
            'ignoreIPv6',
            'preferIPv6',
            'port',
            'host',
            'auth',
            'ignoreTLS',
            'requireTLS',
            'secure',
            'authMethod',
            'poolHash',
            'disabled'
        ].forEach(key => {
            if (key in zone) {
                this[key] = zone[key];
            }
        });

        // If throttling is configured then calculate required parameters
        if (zone.throttling) {
            let throttlingParts = (zone.throttling || '').toString().split('/');
            this.throttling = {
                // how many messages
                messages: Math.ceil(parseInt(throttlingParts.shift(), 10) || 0),
                // per how many seconds
                time:
                    {
                        s: 1,
                        m: 60,
                        h: 3600
                    }[
                        throttlingParts
                            .pop()
                            .trim()
                            .charAt(0)
                            .toLowerCase()
                    ] || 3600,
                // different timers
                timers: new WeakMap()
            };
            if (this.throttling.messages <= 0) {
                this.throttling = false;
            } else {
                // calculate minimum milliseconds before next sending is allowed
                this.throttling.minTime = this.throttling.time * 1000 / this.throttling.messages;
            }
        } else {
            this.throttling = false;
        }

        // If network interface is set
        if (zone.interface) {
            let ifaces = os.networkInterfaces();
            let addresses = [].concat((ifaces && ifaces[zone.interface]) || []).map(iface => ({
                address: iface.address,
                name: hostname,
                resolveName: true
            }));
            this.pool = this.pool.concat(addresses);
        }

        // make sure that all pool entries have a hostname set
        this.pool.forEach(item => {
            if ((!item.name || item.resolveName) && net.isIP(item.address)) {
                item.resolveName = false;
                let addr = item.address;
                if (!item.name) {
                    // assign temporary name as resolving the real one it takes time
                    item.name = hostname;
                }
                dns.reverse(addr, (err, hostnames) => {
                    if (err && err.code !== 'ENOTFOUND') {
                        log.error('DNS', 'Failed to reverse %s. %s', addr, err.message);
                    }
                    if (hostnames && hostnames.length) {
                        item.name = hostnames[0] || item.name;
                    }
                });
            }
        });

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

        this.ipv4Pool = addressTools.divideLoad(this.ipv4Pool);
        this.ipv6Pool = addressTools.divideLoad(this.ipv6Pool);
    }

    getAddress(delivery, useIPv6, disabledAddresses) {
        let key;

        disabledAddresses = disabledAddresses || [];

        switch (delivery.poolHash || this.poolHash) {
            case 'from':
                key = delivery.from || delivery.parsedEnvelope.from || delivery.origin;
                break;
            default:
                key = delivery.id + '.' + delivery.seq;
        }

        let pool = useIPv6 ? this.ipv6Pool : this.ipv4Pool;
        if (disabledAddresses && disabledAddresses.length) {
            pool = pool.filter(entry => !disabledAddresses.includes(entry.address));
            if (!pool.length) {
                // all addresses were filtered out, it's time to bounce
                log.info('Blacklist', '%s.%s DISABLEBL All pooled addresses blacklisted, ignoring blacklist', delivery.id, delivery.seq);
                pool = useIPv6 ? this.ipv6Pool : this.ipv4Pool;
                delivery.poolDisabled = true;
            }
        }

        // Return the same IP for the same delivery. This is needed for greylisting
        // where the server expects request from the same source
        let index = Math.abs(crc32.str(key) % pool.length);
        return pool[index];
    }

    spawnSenders(callback) {
        if (!this.queue || this.queue.closing || this.disabled) {
            return setImmediate(callback);
        }

        let spawnNext = () => {
            if (this.children.size >= this.processes) {
                return setImmediate(() => callback(null, this.children.size));
            }

            if (!this.queue || this.queue.closing || this.disabled) {
                return callback(null, false);
            }

            setImmediate(() => this.spawnSender(spawnNext));
        };

        setImmediate(spawnNext);
    }

    spawnSender(callback) {
        let returned = false;
        let childId = crypto.randomBytes(10).toString('hex');
        let child = child_process.fork(
            __dirname + '/../services/sender.js',
            ['--senderName=' + this.name, '--senderId=' + childId].concat(process.argv.slice(2)),
            {
                env: process.env
            }
        );
        let pid = child.pid;
        log.info('Child/' + this.name + '/' + pid, '[%s] Spawning sender process for %s', childId, this.name);

        let timer = setTimeout(() => {
            if (returned) {
                return;
            }
            returned = true;
            // still nothing from the child process
            log.error('Child/' + this.name + '/' + pid, '[%s] Sender process for %s TIMEOUT on startup', childId, this.name);
            child.kill('SIGTERM');
        }, 2 * 60 * 1000);

        child.once('close', (code, signal) => {
            clearTimeout(timer);
            this.children.delete(child);
            if (this.queue && !this.queue.closing) {
                log.error('Child/' + this.name + '/' + pid, '[%s] Sender process for %s exited with %s', childId, this.name, code || signal);
                // Respawn missing child processes after 5 seconds
                setTimeout(() => this.spawnSenders(() => false), 5 * 1000).unref();
            }
            if (!returned) {
                returned = true;
                return callback(new Error('Child process closed with code ' + code));
            }
        });

        child.once('message', m => {
            if (m && m.startup) {
                clearTimeout(timer);
                // child process should emit a message after startup
                if (!returned) {
                    log.verbose('Child/' + this.name + '/' + pid, '[%s] Sender process for %s ready to take messages', childId, this.name);
                    this.children.add(child);
                    returned = true;
                    return callback(null, true);
                }
            }
        });
    }

    getNextDelivery(lockOwner, callback) {
        if (!this.queue) {
            return callback(new Error('Queue missing'));
        }
        this.queue.shift(
            this.name,
            {
                lockOwner,
                getDomainConfig: (domain, key) => this.domainConfig.get(domain, key)
            },
            callback
        );
    }

    releaseDelivery(delivery, callback) {
        if (!this.queue) {
            return callback(new Error('Queue missing'));
        }
        this.queue.releaseDelivery(delivery, callback);
    }

    removeFromBlacklist(data) {
        let disabledAddresses = this.domainConfig.get(data.domain, 'disabledAddresses');
        if (disabledAddresses.includes(data.address)) {
            for (let i = 0, len = disabledAddresses.length; i < len; i++) {
                if (disabledAddresses[i] === data.address) {
                    disabledAddresses.splice(i, 1);
                    if (disabledAddresses.length) {
                        this.domainConfig.set(data.domain, 'disabledAddresses', disabledAddresses);
                    } else {
                        this.domainConfig.remove(data.domain, 'disabledAddresses');
                    }
                    log.info('Blacklist', '%s.%s DELBLADDRESS De-blacklisting IP %s for %s', data.id, data.seq, data.address, data.domain);
                    return;
                }
            }
        }
    }

    deferDelivery(delivery, ttl, responseData, callback) {
        if (!this.queue) {
            return callback(new Error('Queue missing'));
        }

        if (responseData.category === 'blacklist' && responseData.address && delivery.domain) {
            // block IP for domain
            let disabledAddresses = this.domainConfig.get(delivery.domain, 'disabledAddresses');
            if (!disabledAddresses.includes(responseData.address)) {
                log.info('Blacklist', '%s.%s ADDBLADDRESS Blacklisting IP %s for %s', delivery.id, delivery.seq, responseData.address, delivery.domain);
                disabledAddresses.push(responseData.address);
                this.domainConfig.set(delivery.domain, 'disabledAddresses', disabledAddresses);

                // blacklist IP for MX for next 6 hours
                this.queue.cache.set(
                    'blacklist:' + delivery.domain + ':' + responseData.address,
                    {
                        id: delivery.id,
                        seq: delivery.seq,
                        address: responseData.address,
                        domain: delivery.domain,
                        response: responseData.response,
                        created: Date.now()
                    },
                    config.blacklist.ttl,
                    data => this.removeFromBlacklist(data)
                );
            }
        }

        this.queue.deferDelivery(delivery, ttl, responseData, callback);
    }

    speedometer(ref, next) {
        if (!this.throttling) {
            return next();
        }

        let curTime = Date.now();
        if (!this.throttling.timers.has(ref)) {
            this.throttling.timers.set(ref, curTime);
            return next();
        }

        let timeDiff = curTime - this.throttling.timers.get(ref);

        if (timeDiff >= this.throttling.minTime) {
            this.throttling.timers.set(ref, curTime);
            return next();
        }

        // we hit the speedometer!
        let nextCheck = this.throttling.timers.get(ref) + this.throttling.minTime - curTime + 1;
        this.throttling.timers.set(ref, curTime);
        setTimeout(next, nextCheck);
    }

    generateReceivedHeader(delivery, hostname) {
        let key = 'Received';
        let origin = delivery.origin ? '[' + delivery.origin + ']' : '';
        let originhost = delivery.originhost && delivery.originhost.charAt(0) !== '[' ? delivery.originhost : false;
        origin = [].concat(origin || []).concat(originhost || []);

        if (origin.length > 1) {
            origin = '(' + origin.join(' ') + ')';
        } else {
            origin = origin.join(' ').trim() || 'localhost';
        }

        let value =
            '' +
            // from ehlokeyword
            'from' +
            (delivery.transhost ? ' ' + delivery.transhost : '') +
            // [1.2.3.4]
            ' ' +
            origin +
            (originhost ? '\r\n' : '') +
            // (Authenticated sender: username)
            (delivery.user ? ' (Authenticated sender: ' + delivery.user + ')\r\n' : !originhost ? '\r\n' : '') +
            // by smtphost
            ' by ' +
            hostname +
            // (ZoneMTA)
            (config.name ? ' (' + config.name + ')' : '') +
            // with ESMTP
            ' with ' +
            delivery.transtype +
            // id 12345678
            ' id ' +
            delivery.id +
            '.' +
            delivery.seq +
            '\r\n' +
            // for <receiver@example.com>
            ' for <' +
            delivery.recipient +
            '>' +
            // (version=TLSv1/SSLv3 cipher=ECDHE-RSA-AES128-GCM-SHA256)
            (delivery.tls ? '\r\n (version=' + delivery.tls.version + ' cipher=' + delivery.tls.name + ')' : '') +
            ';' +
            '\r\n' +
            // Wed, 03 Aug 2016 11:32:07 +0000
            ' ' +
            new Date(delivery.time).toUTCString().replace(/GMT/, '+0000');
        return key + ': ' + value;
    }
}

class DomainConfig {
    constructor(options) {
        this.options = options || {};
        this.domains = new Map();
        this.defaults = this.options.defaults || {};

        // ensure defaults
        if (!this.defaults.maxConnections) {
            this.defaults.maxConnections = 5;
        }
        if (!this.defaults.disabledAddresses) {
            this.defaults.disabledAddresses = [];
        } else if (!Array.isArray(this.defaults.disabledAddresses)) {
            this.defaults.disabledAddresses = [].concat(this.defaults.disabledAddresses || []);
        }

        Object.keys(this.options).forEach(domain => {
            if (domain === 'default') {
                return;
            }
            Object.keys(this.options[domain] || {}).forEach(key => {
                this.set(domain, key, this.options[domain][key]);
            });
        });
    }

    set(domain, key, value) {
        if (!this.domains.has(domain)) {
            this.domains.set(domain, new Map());
        }
        this.domains.get(domain).set(key, value);
    }

    get(domain, key) {
        if (!this.domains.has(domain) || !this.domains.get(domain).has(key)) {
            if (this.defaults[key] && typeof this.defaults[key] === 'object') {
                // return clone
                return JSON.parse(JSON.stringify(this.defaults[key]));
            }
            // return defualt value
            return this.defaults[key];
        }
        return this.domains.get(domain).get(key);
    }

    remove(domain, key) {
        if (!this.domains.has(domain) || !this.domains.get(domain).has(key)) {
            return;
        }
        this.domains.get(domain).delete(key);
        if (!this.domains.get(domain).size) {
            this.domains.delete(domain);
        }
    }
}

module.exports.sendingZonelist = sendingZonelist;
module.exports.SendingZone = SendingZone;
module.exports.routingHeaders = routingHeaders;

module.exports.init = (queue, callback) => {
    let domainConfig = new DomainConfig(config.domainConfig);

    callback = callback || (() => false);

    let zoneNames = Object.keys(config.zones || {});
    let zonePos = 0;

    let startNextZone = () => {
        if (zonePos >= zoneNames.length) {
            return callback();
        }
        let zoneName = zoneNames[zonePos++];

        let zoneData = config.zones[zoneName];
        if (!zoneData || zoneData.disabled) {
            return setImmediate(startNextZone);
        }

        let zone = new SendingZone(zoneName, zoneData, domainConfig, queue);
        sendingZonelist.set(zoneName, zone);

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

        if (zoneData.routingHeaders) {
            Object.keys(zoneData.routingHeaders).forEach(key => {
                let value = (zoneData.routingHeaders[key] || '')
                    .toString()
                    .toLowerCase()
                    .trim();
                key = key.toLowerCase().trim();
                if (!key || !value) {
                    return false;
                }

                if (!routingHeaders.has(key)) {
                    routingHeaders.set(key, new Map());
                }

                if (!routingHeaders.get(key).has(value)) {
                    routingHeaders.get(key).set(value, zone);
                }
            });
        }

        if (zoneData.originAddresses) {
            (Array.isArray(zoneData.originAddresses) ? zoneData.originAddresses : [zoneData.originAddresses]).forEach(origin => {
                if (!originMap.has(origin)) {
                    originMap.set(origin, zone);
                }
            });
        }

        if (config.queueServer.enabled) {
            return setImmediate(() => zone.spawnSenders(startNextZone)); // start process spawning
        }

        return setImmediate(startNextZone);
    };

    setImmediate(startNextZone);
};

module.exports.get = name => {
    name = (name || '').toLowerCase().trim();
    return sendingZonelist.get(name);
};

module.exports.list = () => sendingZonelist;

/**
 * Maps a Sending Zone by recipient domain
 *
 * @param {String} domain Domain name to look for
 * @return {String} Sending Zone name
 */
module.exports.findByRecipient = domain => (recipientDomainMap.has(domain) ? recipientDomainMap.get(domain).name : false);

/**
 * Maps a Sending Zone by sender domain
 *
 * @param {String} domain Domain name to look for
 * @return {String} Sending Zone name
 */
module.exports.findBySender = domain => (senderDomainMap.has(domain) ? senderDomainMap.get(domain).name : false);

/**
 * Maps a Sending Zone by message headers
 *
 * @param {Object} headers Header object
 * @return {String} Sending Zone name
 */
module.exports.findByHeaders = headers => {
    if (!routingHeaders.size) {
        // skip checking headers
        return false;
    }

    let lines = headers.getList();

    for (let i = lines.length - 1; i >= 0; i--) {
        let line = lines[i];
        if (routingHeaders.has(line.key)) {
            let zone = routingHeaders.get(line.key).get(
                line.line
                    .substr(line.line.indexOf(':') + 1)
                    .trim()
                    .toLowerCase()
            );
            if (zone) {
                return zone.name;
            }
        }
    }

    return false;
};

/**
 * Maps a Sending Zone by origin IP
 *
 * @param {String} origin Remote IP address
 * @return {String} Sending Zone name
 */
module.exports.findByOrigin = origin => (originMap.has(origin) ? originMap.get(origin).name : false);
