'use strict';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const SMTP_LEVELS = {
    trace: 'TRC',
    debug: 'DBG',
    info: 'INF',
    warn: 'WRN',
    error: 'ERR',
    fatal: 'FTL'
};

module.exports.create = handler => {
    let logger = {};

    LEVELS.forEach(level => {
        logger[level] = handler.bind(null, level);
    });

    return logger;
};

module.exports.toSmtpLevel = level => SMTP_LEVELS[level] || level.toUpperCase();

