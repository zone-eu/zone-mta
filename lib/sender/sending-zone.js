'use strict';

const config = require('config');
const os = require('os');
const net = require('net');
const hostname = os.hostname();
const crc32 = require('crc-32');
const log = require('npmlog');
const addressTools = require('../address-tools');

/**
 * SendingZone class. Shares methods between parent instance and child sender instances
 */
class SendingZone {

    /**
     * Initializes the SendingZone instance
     *
     * @constructor
     * @param {Object} zone Zone configuration
     */
    constructor(name, zone) {
        this.name = (name || '').toLowerCase().trim();

        // connections per child processes
        this.connections = zone.connections || 1;

        this.closing = false;

        let pool = zone.pool;
        if (typeof zone.pool === 'string' && config.pools[zone.pool]) {
            pool = config.pools[zone.pool];
        }
        this.pool = [].concat(pool || []);

        // copy properties from the config object
        ['logger', 'logLevel', 'resolveIp', 'ignoreIPv6', 'port', 'host', 'auth', 'ignoreTLS', 'requireTLS', 'secure', 'authMethod', 'poolHash', 'disabled'].forEach(key => {
            if (key in zone) {
                this[key] = zone[key];
            }
        });

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
                // all addresses were filtered out, ignore filtering
                log.info('Blacklist', '%s.%s DISABLEBL All pooled addresses blacklisted, ignoring blacklist', delivery.id, delivery.seq);
                pool = useIPv6 ? this.ipv6Pool : this.ipv4Pool;
            }
        }

        // Return the same IP for the same delivery. This is needed for greylisting
        // where the server expects request from the same source
        let index = Math.abs(crc32.str(key) % pool.length);
        return pool[index];
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

        let value = '' +
            // from ehlokeyword
            'from' + (delivery.transhost ? ' ' + delivery.transhost : '') +
            // [1.2.3.4]
            ' ' + origin +
            (originhost ? '\r\n' : '') +

            // (Authenticated sender: username)
            (delivery.user ? ' (Authenticated sender: ' + delivery.user + ')\r\n' : (!originhost ? '\r\n' : '')) +

            // by smtphost
            ' by ' + hostname +
            // (ZoneMTA)
            (config.name ? ' (' + config.name + ')' : '') +
            // with ESMTP
            ' with ' + delivery.transtype +
            // id 12345678
            ' id ' + delivery.id + '.' + delivery.seq +
            '\r\n' +

            // for <receiver@example.com>
            ' for <' + delivery.recipient + '>' +
            // (version=TLSv1/SSLv3 cipher=ECDHE-RSA-AES128-GCM-SHA256)
            (delivery.tls ? '\r\n (version=' + delivery.tls.version + ' cipher=' + delivery.tls.name + ')' : '') +

            ';' +
            '\r\n' +

            // Wed, 03 Aug 2016 11:32:07 +0000
            ' ' + new Date(delivery.time).toUTCString().replace(/GMT/, '+0000');
        return key + ': ' + value;
    }
}

module.exports = SendingZone;
