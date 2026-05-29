'use strict';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

module.exports.create = handler => {
    let logger = {};

    LEVELS.forEach(level => {
        logger[level] = handler.bind(null, level);
    });

    return logger;
};
