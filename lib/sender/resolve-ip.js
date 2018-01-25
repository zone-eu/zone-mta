'use strict';

const dns = require('dns');
const net = require('net');
const dnsErrors = require('./dns-errors');
const ipTools = require('./ip-tools');

// we do not reject on error to avoid issues where one failing MX record kills entire sending
function resolve4(mx) {
    return new Promise(resolve => {
        dns.resolve4(mx.exchange, (err, list) => {
            if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                mx.A = [].concat({ error: err, exchange: mx.exchange });
            } else {
                mx.A = [].concat(list || []);
            }
            resolve(mx);
        });
    });
}

function resolve6(mx) {
    return new Promise(resolve => {
        dns.resolve6(mx.exchange, (err, list) => {
            if (err && err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
                mx.AAAA = [].concat({ error: err, exchange: mx.exchange });
            } else {
                mx.AAAA = [].concat(list || []);
            }
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
            if (ip && ip.error) {
                if (!firstError) {
                    firstError = ip.error;
                    firstError.exchange = ip.exchange;
                    firstError.response =
                        '550 Failed to resolve IP address for ' +
                        ip.exchange +
                        ' of the MX server for ' +
                        delivery.domain +
                        '. ' +
                        (dnsErrors[firstError.code] || firstError.message);
                    firstError.category = 'dns';
                }
                return false;
            }
            let invalid = ipTools.isInvalid(delivery, ip);
            if (invalid) {
                if (!firstError) {
                    firstError = new Error(
                        'Can not send mail to the resolved IP address [' +
                            ip +
                            '] of the MX server for ' +
                            delivery.domain +
                            (typeof invalid === 'string' ? '. ' + invalid : '')
                    );
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

        Promise.all(resolveAddresses)
            .then(() => {
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
                    let err = new Error('Could not resolve any IP addresses for the MX server for ' + delivery.domain);
                    err.response = '550 ' + err.message;
                    err.category = 'dns';
                    return reject(err);
                }
                resolve(delivery);
            })
            .catch(err => {
                err.message = delivery.decodedDomain + ': ' + (dnsErrors[err.code] || err.message);
                err.step = 'dns';
                reject(err);
            });
    });
}

module.exports = resolveIP;
