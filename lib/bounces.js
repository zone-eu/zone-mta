'use strict';
const log = require('npmlog');
const fs = require('fs');
const path = require('path');

let body;

try {
    body = fs.readFileSync(path.join(__dirname, '..', 'config', 'bounces.txt'), 'utf-8');
} catch (E) {
    log.error('Init', 'Could not load bounce rules');
    log.error('Init', E);
    process.exit(1);
}

// Parse defined rules into an array of bounce rules
module.exports.rules = body.split(/\r?\n/).map((line, nr) => {
    line = line.trim();

    if (!line || line.charAt(0) === '#') {
        return false;
    }

    let parts = line.split(',');
    let re;

    try {
        re = new RegExp(parts[0], 'im');
    } catch (E) {
        log.error('Init', 'Invalid bounce rule regex /%s/ on line %s', parts[0], nr + 1);
    }

    return {
        re,
        action: parts[1],
        category: parts[2],
        message: parts.slice(3).join(',')
    };
}).filter(rule => rule && rule.re);
body = null;

module.exports.check = str => {
    str = (str || '').toString().replace(/\s+/g, ' ').trim();
    if (!str) {
        return {
            action: 'reject',
            message: 'Unknown',
            category: 'other',
            code: 0,
            status: false
        };
    }

    let parts = str.substr(0, 100).split(/[\-\s]+/);
    let code = Number(parts[0]) || 0;
    let status = /^(\d+\.)+\d+$/.test(parts[1]) ? parts[1] : false;

    for (let i = 0, len = module.exports.rules.length; i < len; i++) {
        if (module.exports.rules[i].re.test(str)) {
            return {
                action: module.exports.rules[i].action,
                message: module.exports.rules[i].message,
                category: module.exports.rules[i].category,
                code,
                status
            };
        }
    }

    // no idea, just reject
    return {
        action: 'reject',
        message: 'Unknown',
        code,
        status
    };
};
