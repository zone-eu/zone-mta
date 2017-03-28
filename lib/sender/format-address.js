'use strict';

const net = require('net');
const punycode = require('punycode');

function formatAddress(delivery) {
    // Check if the domain looks like an IP literal. IP addresses need to be enclosed in square brackets
    //     user@[127.0.0.1]
    //     user@[IPv6:2001:db8:1ff::a0b:dbd0]
    delivery.isIp = /^\[(ipv6:)?[^\]]+\]$/i.test(delivery.domain) || net.isIP(delivery.domain);

    delivery.isPunycode = false;

    if (delivery.isIp) {
        // remove the enclosing brackets
        delivery.decodedDomain = delivery.domain.replace(/^\[(ipv6:)?|\]$/gi, '');
        if (!net.isIP(delivery.decodedDomain)) {
            // the result does not seem to be either IPv4 or IPv6 address
            let err = new Error(delivery.decodedDomain + ' does not appear to be a properly formatted IP address');
            err.response = '550 ' + err.message;
            err.category = 'compliancy';
            return Promise.reject(err);
        }
        if (net.isIPv6(delivery.decodedDomain) && delivery.dnsOptions.ignoreIPv6) {
            let err = new Error(delivery.decodedDomain + ': Can not send mail to IPv6 addresses');
            err.response = '550 ' + err.message;
            err.category = 'dns';
            return Promise.reject(err);
        }
    } else {
        // decode potential unicode in domain part. If nothing was changed then the domain did not use unicode
        //     user@jõgeva.公司
        delivery.decodedDomain = punycode.toASCII(delivery.domain);
        delivery.isPunycode = delivery.decodedDomain !== delivery.domain;
    }

    return Promise.resolve(delivery);
}

module.exports = formatAddress;
