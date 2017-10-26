'use strict';

const formatAddress = require('./format-address');
const resolveMX = require('./resolve-mx');
const resolveIP = require('./resolve-ip');
const getConnection = require('./get-connection');

module.exports = (delivery, callback) => {
    if (delivery.mx) {
        // delivery domain is already processed

        if (delivery.mx.find(mx => mx.exchange && !mx.A.length && !mx.AAAA.length)) {
            // IP not yet resolved
            return resolveIP(delivery)
                .then(getConnection)
                .then(mx => callback(null, mx))
                .catch(callback);
        }

        return getConnection(delivery)
            .then(mx => callback(null, mx))
            .catch(callback);
    }
    // resolve MX and A/AAAA addresses
    formatAddress(delivery)
        .then(resolveMX)
        .then(resolveIP)
        .then(getConnection)
        .then(mx => callback(null, mx))
        .catch(callback);
};
