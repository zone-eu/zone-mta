'use strict';

// streams through a message body and calculates relaxed body hash

const config = require('config');
const Transform = require('stream').Transform;
const crypto = require('crypto');

class DkimRelaxedBody extends Transform {
    constructor(options) {
        super(options);
        this.chunkBuffer = [];
        this.chunkBufferLen = 0;
        this.bodyHash = crypto.createHash(config.dkim.hash);
        this.remainder = '';
    }

    updateHash(chunk) {
        let bodyStr;

        if (chunk) {
            bodyStr = this.remainder + chunk.toString('binary');
            if (bodyStr.length < 1024) {
                this.remainder = bodyStr;
                return;
            }
            this.remainder = bodyStr.substr(-1024);
            bodyStr = bodyStr.substr(0, bodyStr.length - this.remainder.length);
        } else {
            // final call
            bodyStr = this.remainder;
        }

        // ignore trailing <CR>
        if (bodyStr.length && bodyStr.substr(-1) === '\r') {
            bodyStr = bodyStr.substr(0, bodyStr.length - 1);
        }

        bodyStr = bodyStr.
        replace(/\r?\n|\r/g, '\n'). // use js line endings
        replace(/[ \t]*$/mg, ''). // remove line endings, rtrim
        replace(/[ \t]+/mg, ' '); // single spaces

        if (!chunk) {
            bodyStr = bodyStr.replace(/\n+$/, '\n'); // remove trailing lines for final part
        }

        bodyStr = bodyStr.replace(/\n/g, '\r\n'); // restore rfc822 line endings

        let bodyChunk = Buffer.from(bodyStr, 'binary');
        this.bodyHash.update(bodyChunk);
    }

    _transform(chunk, encoding, callback) {
        if (!chunk || !chunk.length) {
            return callback();
        }

        if (typeof chunk === 'string') {
            chunk = new Buffer(chunk, encoding);
        }

        this.updateHash(chunk);

        this.push(chunk);
        callback();
    }

    _flush(callback) {
        // generate final hash and emit it
        this.updateHash();
        this.emit('hash', this.bodyHash.digest('base64'));

        callback();
    }
}

module.exports = DkimRelaxedBody;
