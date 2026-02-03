'use strict';

const log = require('npmlog');

// Build the standardized GELF code prefix (COMPONENT [CODE]) for short_message.
const gelfCode = code => `${(log._gelfComponent || 'MTA').toUpperCase()} [${code}]`;

// Use emitGelf when you are outside of app.js (or any entrypoint that ran log-setup)
// and you need a safe GELF emit with a console fallback.
// Use log.loggelf directly when you are sure log-setup has been run in the process.
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
