'use strict';

const dns = require('dns');
const net = require('net');
const dnsErrors = require('./dns-errors');
const ipTools = require('./ip-tools');

function resolve4(mx) {
    return new Promise((resolve, reject) => {
        dns.resolve4(mx.exchange, (err, list) => {
            if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                return reject(err);
            }
            // only include valid IP addresses in the response
            mx.A = [].concat(list || []);
            resolve(mx);
        });
    });
}

function resolve6(mx) {
    return new Promise((resolve, reject) => {
        dns.resolve6(mx.exchange, (err, list) => {
            if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                return reject(err);
            }
            // only include valid IP addresses in the response
            mx.AAAA = [].concat(list || []);
            resolve(mx);
        });
    });
}

function resolveIP(delivery) {
    return new Promise((resolve, reject) => {

        let resolveAddresses = [];
        let firstError = false;
        let addressFound = false;

        let filterAddress = ip => {
            let invalid = ipTools.isInvalid(delivery, ip);
            if (invalid) {
                if (!firstError) {
                    firstError = new Error('Can not connect to blocked MX host [' + ip + '] for ' + delivery.domain);
                    firstError.response = '550 ' + firstError.message;
                    firstError.category = 'dns';
                }
            } else {
                addressFound = true;
            }
            return !invalid;
        };

        delivery.mx.forEach(entry => {
            if (entry.exchange && !net.isIP(entry.exchange)) {
                resolveAddresses.push(resolve4(entry));
                if (!delivery.dnsOptions.ignoreIPv6) {
                    resolveAddresses.push(resolve6(entry));
                }
            }
        });

        Promise.all(resolveAddresses).then(() => {
            // filter invalid IP addresses
            delivery.mx.forEach(entry => {
                // filter invalid IP addresses
                entry.A = entry.A.filter(filterAddress);
                entry.AAAA = entry.AAAA.filter(filterAddress);
            });

            if (!addressFound) {
                if (firstError) {
                    return reject(firstError);
                }
                let err = new Error('Could not resolve any IP addresses for MX of ' + delivery.domain);
                err.response = '550 ' + err.message;
                err.category = 'dns';
                return reject(err);
            }
            resolve(delivery);
        }).catch(err => {
            err.message = delivery.decodedDomain + ': ' + (dnsErrors[err.code] || err.message);
            err.step = 'dns';
            reject(err);
        });

    });
}

module.exports = resolveIP;
