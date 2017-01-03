'use strict';

const Transform = require('stream').Transform;

class ByteCounter extends Transform {
    constructor(options) {
        super(options);

        this.created = Date.now();
        this.started = false;
        this.finished = false;
        this.byteSize = 0;
        this.finished = false;
    }

    _transform(chunk, encoding, callback) {
        if (chunk && chunk.length) {
            if (!this.started) {
                this.started = Date.now();
            }
            this.byteSize += chunk.length;
        }
        return callback(null, chunk);
    }

    stats() {
        return {
            size: this.byteSize,
            time: this.finished ? this.finished - this.created : false,
            start: this.started ? this.started - this.created : false
        };
    }

    _flush(callback) {
        this.finished = Date.now();
        callback();
    }
}

module.exports = ByteCounter;
