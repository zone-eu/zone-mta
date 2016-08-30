'use strict';

const Transform = require('stream').Transform;

/**
 * MessageParser instance is a transform stream that separates message headers
 * from the rest of the body. Headers are emitted with the 'headers' event. Message
 * body is passed on as the resulting stream.
 */
class MessageParser extends Transform {
    constructor() {
        let options = {
            readableObjectMode: false,
            writableObjectMode: true
        };
        super(options);
        this.headers = false;
    }

    _transform(data, encoding, callback) {
        if (!this.headers && data.type === 'node') {
            this.headers = data.headers;
            this.emit('headers', this.headers);
        } else {
            this.push(typeof data.getHeaders === 'function' ? data.getHeaders() : data.value);
        }

        setImmediate(callback);
    }

    _flush(callback) {
        callback();
    }
}

module.exports = MessageParser;
