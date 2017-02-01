'use strict';

const config = require('config');
const dns = require('dns');
const net = require('net');
const os = require('os');
const ipaddr = require('ipaddr.js');
const nameservers = [].concat(config.nameservers || []);
const localAddresses = returnLocalAddresses(os.networkInterfaces());

// set the nameservers to use for resolving
if (nameservers.length) {
    dns.setServers(nameservers);
}

/**
 * Resolves IP address for a domin name
 *
 * @param {String} domain The domain name to check for
 * @param {Object} options Options for the resolver
 * @param {Boolean} options.preferIPv6 If true then lists IPv6 addresses first
 * @param {Boolean} options.ignoreIPv6 If true then does not check for IPv6 addresses
 * @param {Function} callback Function that returns a list of resolved IP addresses
 */
module.exports.resolveIp = (domain, options, callback) => {
    options = options || {};
    if (net.isIP(domain)) {
        return callback(null, [domain]);
    }
    let returned = 0;
    let ipv6List, ipv4List;
    let ipv6err, ipv4err;

    let done = () => {
        let list = [];

        if (ipv6err && ipv4err) {
            return callback(null, ipv4err);
        }

        if (ipv6List || ipv4List) {
            if (options.preferIPv6) {
                list = list.concat(ipv6List || []).concat(ipv4List || []);
            } else {
                list = list.concat(ipv4List || []).concat(ipv6List || []);
            }
        }

        return callback(null, list);
    };

    if (options.ignoreIPv6) {
        returned++;
        ipv6List = [];
    } else {
        dns.resolve6(domain, (err, list) => {
            returned++;
            // c-ares returns either ENODATA or ENOTFOUND if no match was found
            if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                ipv6err = err;
                ipv6err.category = 'dns';
            } else if (list) {
                ipv6List = list;
            }
            if (returned === 2) {
                return done();
            }
        });
    }
    dns.resolve4(domain, (err, list) => {
        returned++;
        if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
            ipv4err = err;
            ipv4err.category = 'dns';
        } else if (list) {
            ipv4List = list;
        }
        if (returned === 2) {
            return done();
        }
    });
};

/**
 * This method resolves MX servers for an address domain. If no MX records are found
 * the method fallbacks to A/AAAA records
 *
 * @param {String} domain Address domain
 * @param {Function} callback Function that returns the resolved addresses, sorted by priority
 */
module.exports.resolveMx = (domain, options, callback) => {
    options = options || {};
    domain = domain.replace(/^\[(ipv6:)?|\]$/gi, '');

    // Do not try to resolve the domain name if it is an IP address
    if (net.isIP(domain)) {
        return callback(null, [{
            priority: 0,
            exchange: domain
        }]);
    }

    dns.resolveMx(domain, (err, list) => {
        if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
            err.category = 'dns';
            return callback(err);
        }

        if (!list || !list.length) {
            // fallback to A
            return dns.resolve4(domain, (err, list) => {
                if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                    err.category = 'dns';
                    return callback(err);
                }

                if (!list || !list.length) {
                    // fallback to AAAA
                    return dns.resolve6(domain, (err, list) => {
                        if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                            err.category = 'dns';
                            return callback(err);
                        }

                        if (!list || !list.length) {
                            // nothing found!
                            return callback(null, false);
                        }

                        // return the first resolved Ipv6 with priority 0
                        return callback(null, [].concat(list || []).map(entry => ({
                            priority: 0,
                            exchange: entry
                        })).slice(0, 1));
                    });
                }

                // return the first resolved Ipv4 with priority 0
                return callback(null, [].concat(list || []).map(entry => ({
                    priority: 0,
                    exchange: entry
                })).slice(0, 1));
            });
        }

        list = list.sort((a, b) => a.priority - b.priority);

        // return whatever the resolve method gave us
        callback(null, list.length ? list : false);
    });
};

module.exports.isLocal = address => localAddresses.has(address);
module.exports.isInvalid = address => {
    if (net.isIP(address)) {
        let range = ipaddr.parse(address).range();
        if (['unspecified', 'loopback', 'private', 'broadcast'].includes(range)) {
            return range;
        }
    }
    return false;
};

function returnLocalAddresses(interfaces) {
    let addresses = new Set();

    addresses.add('0.0.0.0');

    Object.keys(interfaces || {}).forEach(key => {
        let iface = interfaces[key];
        if (!iface) {
            return;
        }
        [].concat(iface || []).forEach(addr => {
            if (addr && addr.address) {
                addresses.add(addr.address);
            }
        });
    });

    return addresses;
}
