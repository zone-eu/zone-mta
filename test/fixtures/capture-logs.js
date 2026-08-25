'use strict';

const util = require('util');
const log = require('npmlog');

const CAPTURED_LEVELS = ['silly', 'verbose', 'info', 'warn', 'error'];

// Captures every npmlog level the SMTP code can route to, so output that ends up on an
// unexpected level fails the assertions instead of leaking to the console
module.exports = function captureLogs(callback) {
    let originals = new Map();
    let entries = [];

    CAPTURED_LEVELS.forEach(level => {
        originals.set(level, log[level]);
        log[level] = (...args) => entries.push({ level, prefix: args[0], message: util.format(...args.slice(1)) });
    });

    try {
        return callback(entries);
    } finally {
        originals.forEach((original, level) => {
            log[level] = original;
        });
    }
};
