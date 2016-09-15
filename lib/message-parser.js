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
            if (typeof this.onHeaders === 'function') {
                return this.onHeaders(this.headers, callback);
            }
        } else {
            let buf = data.type === 'node' ? data.getHeaders() : data.value;
            this.push(buf);
        }

        setImmediate(callback);
    }

    _flush(callback) {
        callback();
    }
}

module.exports = MessageParser;
