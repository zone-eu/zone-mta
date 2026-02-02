'use strict';

const os = require('os');
const Gelf = require('gelf');
const log = require('npmlog');

module.exports = config => {
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
