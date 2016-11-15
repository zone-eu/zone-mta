'use strict';

const Transform = require('stream').Transform;
const crypto = require('crypto');

class StreamHash extends Transform {
    constructor(config) {
        config = config || {};
        super();
        this.hash = crypto.createHash(config.algo || 'md5');
        this.bytes = 0;
    }

    _transform(chunk, encoding, callback) {
        this.hash.update(chunk);
        this.bytes += chunk.length;
        this.push(chunk);
        callback();
    }

    _flush(callback) {
        this.emit('hash', {
            hash: this.hash.digest('hex'),
            bytes: this.bytes
        });
        callback();
    }
}

module.exports = StreamHash;
