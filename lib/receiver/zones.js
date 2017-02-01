'use strict';

const config = require('config');
const punycode = require('punycode');

let recipientDomainMap = new Map();
let senderDomainMap = new Map();
let routingHeaders = new Map();
let originMap = new Map();

module.exports.list = new Set();

Object.keys(config.zones || {}).forEach(zoneName => {
    let zoneData = config.zones[zoneName];
    if (!zoneData || zoneData.disabled) {
        return;
    }
    module.exports.list.add(zoneName);

    if (zoneData.senderDomains) {
        (Array.isArray(zoneData.senderDomains) ? zoneData.senderDomains : [zoneData.senderDomains]).forEach(domain => {
            domain = punycode.toASCII(domain.toLowerCase().trim());
            if (!senderDomainMap.has(domain)) {
                senderDomainMap.set(domain, zoneName);
            }
        });
    }

    if (zoneData.recipientDomains) {
        (Array.isArray(zoneData.recipientDomains) ? zoneData.recipientDomains : [zoneData.recipientDomains]).forEach(domain => {
            domain = punycode.toASCII(domain.toLowerCase().trim());
            if (!recipientDomainMap.has(domain)) {
                recipientDomainMap.set(domain, zoneName);
            }
        });
    }

    if (zoneData.routingHeaders) {
        Object.keys(zoneData.routingHeaders).forEach(key => {
            let value = (zoneData.routingHeaders[key] || '').toString().toLowerCase().trim();
            key = key.toLowerCase().trim();
            if (!key || !value) {
                return false;
            }

            if (!routingHeaders.has(key)) {
                routingHeaders.set(key, new Map());
            }

            if (!routingHeaders.get(key).has(value)) {
                routingHeaders.get(key).set(value, zoneName);
            }
        });
    }

    if (zoneData.originAddresses) {
        (Array.isArray(zoneData.originAddresses) ? zoneData.originAddresses : [zoneData.originAddresses]).forEach(origin => {
            if (!originMap.has(origin)) {
                originMap.set(origin, zoneName);
            }
        });
    }
});

/**
 * Maps a Sending Zone by recipient domain
 *
 * @param {String} domain Domain name to look for
 * @return {String} Sending Zone name
 */
module.exports.findByRecipient = domain => recipientDomainMap.get(domain);

/**
 * Maps a Sending Zone by sender domain
 *
 * @param {String} domain Domain name to look for
 * @return {String} Sending Zone name
 */
module.exports.findBySender = domain => senderDomainMap.get(domain);

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
            let zone = routingHeaders.get(line.key).get(line.line.substr(line.line.indexOf(':') + 1).trim().toLowerCase());
            if (zone) {
                return zone;
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
module.exports.findByOrigin = origin => originMap.get(origin);
