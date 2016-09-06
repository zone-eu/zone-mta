'use strict';

const msgpack = require('msgpack-js');

function parse(frame) {
    if (!frame || !frame.length) {
        return false;
    }
    return msgpack.decode(frame);
}

function encode(data) {
    let encoded = msgpack.encode(data);
    let frame = Buffer.allocUnsafe(encoded.length + 4);
    frame.writeUInt32LE(encoded.length, 0);
    encoded.copy(frame, 4);
    return frame;
}

module.exports = {
    parse,
    encode
};
