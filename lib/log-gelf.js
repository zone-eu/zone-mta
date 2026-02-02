'use strict';

const log = require('npmlog');

const gelfCode = code => `${(log._gelfComponent || 'MTA').toUpperCase()} [${code}]`;

const emitGelf = (message, requiredKeys = ['short_message']) => {
    if (typeof log.loggelf === 'function') {
        return log.loggelf(message, requiredKeys);
    }

    let payload = message;
    if (typeof message === 'string') {
        payload = {
            short_message: message
        };
    }

    log.info('Gelf', JSON.stringify(payload || {}));
};

module.exports = { gelfCode, emitGelf };
