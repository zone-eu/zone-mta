'use strict';

const config = require('config');
const log = require('npmlog');
const dgram = require('dgram');
const msgpack = require('msgpack-js');

module.exports = (id, seq, action, data) => {
    if (!config.log.remote) {
        return;
    }

    let message = {
        id
    };
    if (seq) {
        message.seq = seq;
    }
    if (action) {
        message.action = action;
    }
    if (data) {
        Object.keys(data).forEach(key => {
            if (!(key in message)) {
                message[key] = data[key];
            }
        });
    }
    let payload;
    try {
        payload = msgpack.encode(message);
    } catch (E) {
        log.error('REMOTELOG', '%s Failed encoding message. error="%s"', id + (seq ? '.' + seq : ''), E.message);
    }

    let client = dgram.createSocket(config.log.remote.protocol);
    client.send(payload, config.log.remote.port, config.log.remote.host || 'localhost', () => client.close());
};
