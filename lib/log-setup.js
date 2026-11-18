'use strict';

const os = require('os');
const Gelf = require('gelf');
const log = require('npmlog');

// npmlog writes the level, the prefix and the message of an entry as separate writes.
// Sender and receiver processes share the output of the main process, so when several
// processes log at the same time these pieces get interleaved and lines are merged or split.
// Collect the pieces and write each complete line with a single write.
const createLineStream = target => {
    let pending = '';

    return {
        lineBuffered: true,
        isTTY: target.isTTY,
        columns: target.columns,
        write(chunk) {
            pending += chunk;

            const end = pending.lastIndexOf('\n');
            if (end < 0) {
                return true;
            }

            const lines = pending.slice(0, end + 1);
            pending = pending.slice(end + 1);
            return target.write(lines);
        }
    };
};

module.exports = config => {
    if (!log.stream.lineBuffered) {
        log.stream = createLineStream(log.stream);
    }

    const gelfConfig = (config && config.log && config.log.gelf) || {};
    const component = gelfConfig.component || 'mta';
    const hostname = gelfConfig.hostname || os.hostname();
    const gelfEnabled = !!(gelfConfig && gelfConfig.enabled);
    const gelf = gelfEnabled ? new Gelf(gelfConfig.options) : null;

    log._gelfComponent = (component || 'mta').toUpperCase();

    const loggelf = (message, requiredKeys = []) => {
        if (typeof message === 'string') {
            message = {
                short_message: message
            };
        }
        message = message || {};

        if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
            message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
        }

        message.facility = component;
        message.host = hostname;
        message.timestamp = Date.now() / 1000;
        message._component = component;
        Object.keys(message).forEach(key => {
            if (!message[key] && !requiredKeys.includes(key)) {
                // remove the key if it empty/falsy/undefined/null and it is not required to stay
                delete message[key];
            }
        });
        if (gelf) {
            gelf.emit('gelf.log', message);
        } else {
            log.info('Gelf', JSON.stringify(message));
        }
    };

    log.gelfEnabled = gelfEnabled;
    log.loggelf = loggelf;

    return log;
};
