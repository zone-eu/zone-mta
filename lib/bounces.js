'use strict';
const log = require('npmlog');
const fs = require('fs');
const path = require('path');

function reloadBounces() {
    let body;

    try {
        body = fs.readFileSync(path.join(__dirname, '..', 'config', 'bounces.txt'), 'utf-8');
    } catch (E) {
        log.error('Bounces/' + process.pid, 'Could not load bounce rules. %s', E.message);
        if (module.exports.rules && module.exports.rules.length) {
            return;
        }
        process.exit(1);
    }

    // Parse defined rules into an array of bounce rules
    module.exports.rules = body
        .split(/\r?\n/)
        .map((line, nr) => {
            line = line.trim();

            if (!line || line.charAt(0) === '#') {
                return false;
            }

            let parts = line.split(',');
            let re;

            try {
                re = new RegExp(parts[0], 'im');
            } catch (E) {
                log.error('Bounces/' + process.pid, 'Invalid bounce rule regex /%s/ on line %s', parts[0], nr + 1);
            }

            return {
                re,
                action: parts[1],
                category: parts[2],
                message: parts.slice(3).join(','),
                line: nr + 1
            };
        })
        .filter(rule => rule && rule.re);
    body = null;

    log.verbose('Bounces/' + process.pid, 'Loaded %s bounce rules', module.exports.rules.length);
}

module.exports.reloadBounces = reloadBounces;

module.exports.formatSMTPResponse = formatSMTPResponse;

module.exports.check = (input, category) => {
    let str = formatSMTPResponse(input);
    if (!str) {
        return {
            action: 'reject',
            message: 'Unknown',
            category: category || 'other',
            code: 0,
            status: false
        };
    }

    let parts = str.substr(0, 100).split(/[-\s]+/);
    let code = Number(parts[0]) || 0;
    let status = /^(\d+\.)+\d+$/.test(parts[1]) ? parts[1] : false;

    switch (category) {
        case 'dns':
            if (code && code > 500) {
                break;
            }
            return {
                action: 'defer',
                message: str.replace(/^[\d.\s]+/, ''),
                category,
                code,
                status
            };
    }

    for (let i = 0, len = module.exports.rules.length; i < len; i++) {
        if (module.exports.rules[i].re.test(str)) {
            return {
                action: module.exports.rules[i].action,
                message: module.exports.rules[i].message,
                category: module.exports.rules[i].category,
                code,
                status,
                line: module.exports.rules[i].line
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

function formatSMTPResponse(str) {
    str = (str || '').toString().trim();
    let code = str.match(/^\d{3}[\s-]+([\d.]+\s*)?/);
    return ((code ? code[0] : '') + (code ? str.substr(code[0].length) : str).replace(/^\d{3}[\s-]+([\d.]+\s*)?/gm, ' ')).replace(/\s+/g, ' ').trim();
}

reloadBounces();
