'use strict';

const config = require('wild-config');
const log = require('npmlog');
const dgram = require('dgram');
const msgpack = require('msgpack-js');
const plugins = require('./plugins');

module.exports = (id, seq, action, data) => {
    let entry = {
        id
    };
    if (seq) {
        entry.seq = seq;
    }
    if (action) {
        entry.action = action;
    }
    if (data) {
        Object.keys(data).forEach(key => {
            if (!(key in entry)) {
                entry[key] = data[key];
            }
        });
    }

    if (config.log.remote) {
        let payload;
        try {
            payload = msgpack.encode(entry);
        } catch (E) {
            log.error('REMOTELOG', '%s Failed encoding message. error="%s"', id + (seq ? '.' + seq : ''), E.message);
        }

        let client = dgram.createSocket(config.log.remote.protocol);
        client.send(payload, config.log.remote.port, config.log.remote.host || 'localhost', () => client.close());
    }

    plugins.handler.runHooks('log:entry', [entry], () => false);
};
