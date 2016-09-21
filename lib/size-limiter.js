'use strict';

const Transform = require('stream').Transform;

class SizeLimiter extends Transform {
    constructor(options) {
        super();
        this.options = options || {};
        this.maxSize = Number(this.options.maxSize);
        this.byteSize = 0;
        this.finished = false;
    }

    _transform(chunk, encoding, callback) {
        if (!chunk || !chunk.length) {
            return callback();
        }

        if (typeof chunk === 'string') {
            chunk = new Buffer(chunk, encoding);
        }

        this.byteSize += chunk.length;

        if (this.finished) {
            return callback();
        }

        if (this.byteSize > this.maxSize) {
            this.finished = true;
        }

        this.push(chunk);

        return callback();
    }

    _flush(callback) {
        if (this.finished) {
            let err = new Error('Error: message exceeds fixed maximum message size ' + this.maxSize + ' B (' + this.byteSize + ' B)');
            err.responseCode = 552;
            return callback(err);
        }
        callback();
    }
}

module.exports = SizeLimiter;
