'use strict';

// This module checks which local user has opened specific port
// Run as root to find other users

const os = require('os');
const spawn = require('child_process').spawn;
const interfaces = os.networkInterfaces();

// Find all private IP addresses. We do not care about ports that have been opened against remote destinations
const localAddresses = new Set();
Object.keys(interfaces).forEach(key => {
    if (Array.isArray(interfaces[key])) {
        interfaces[key].forEach(address => {
            if (address && address.internal && address.address) {
                localAddresses.add(address.address);
            }
        });
    }
});

// lsof -n -P -M -l -sTCP:ESTABLISHED -iTCP:PORT

function parseLsof(data) {

    let lines = (data || '').toString().trim().split(/\r?\n/);
    let titles = lines.shift().toLowerCase().split(/\s+/);
    let parsed = [];

    lines.forEach(line => {
        let tabs = line.split(/\s+/);
        let item = new Map();
        let key, value, parts, source, dest, sourceIp, sourcePort, destIp, destPort;
        for (let i = 0, len = tabs.length; i < len; i++) {
            key = titles[i] || '';
            value = tabs[i] || '';

            if (key === 'name') {
                parts = value.split('->');
                source = parts[0] || '';
                dest = parts[1] || '';
                sourceIp = source.substr(0, source.lastIndexOf(':')).replace(/[\[\]]/g, '');
                sourcePort = source.substr(source.lastIndexOf(':') + 1);
                destIp = dest.substr(0, dest.lastIndexOf(':')).replace(/[\[\]]/g, '');
                destPort = dest.substr(dest.lastIndexOf(':') + 1);
                if (sourcePort && destPort) {
                    item.set('sourceIp', sourceIp);
                    item.set('destIp', destIp);
                    item.set('sourcePort', parseInt(sourcePort, 10));
                    item.set('destPort', parseInt(destPort, 10));
                }
            }

            if (key === 'user') {
                if (value) {
                    value = parseInt(value, 10);
                } else {
                    value = false;
                }
            }

            item.set(key, value);
        }
        parsed.push(item);
    });

    return parsed;
}

function checkLsof(port, options, callback) {
    options = options || {};

    port = parseInt(port, 10);

    if (!port) {
        return setImmediate(() => {
            callback(new Error('Invalid port option'));
        });
    }

    let lsofArgs = [].concat(options.args || ['-n', '-P', '-M', '-l', '-sTCP:ESTABLISHED']).concat('-iTCP:' + port);
    let lsofCommand = options.cmd || 'lsof';

    let lsof = spawn(lsofCommand, lsofArgs);
    let stderr = '';
    let stdout = '';

    lsof.stdout.on('data', data => {
        stdout += data.toString();
    });

    lsof.stderr.on('data', data => {
        stderr += data.toString();
    });

    lsof.on('close', code => {
        if (code) {
            if (code === 1) {
                return callback(null, false); // nothing found
            }

            let err = new Error('lsof exited with code ' + code);
            err.stderr = stderr;
            return callback(err);
        }

        return callback(null, stdout);
    });
}

module.exports = function (port, options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = null;
    }
    port = parseInt(port, 10);
    checkLsof(port, options, (err, data) => {
        if (err) {
            return callback(err);
        }
        if (!data) {
            return callback(null, false);
        }
        let parsed = parseLsof(data);
        for (let i = 0, len = parsed.length; i < len; i++) {
            if (localAddresses.has(parsed[i].get('sourceIp')) && parsed[i].get('sourcePort') === port) {
                return callback(null, parsed[i].get('user'));
            }
        }
        return callback(null, false);
    });
};

// expose for testing
module.exports.parseLsof = parseLsof;
module.exports.checkLsof = checkLsof;
