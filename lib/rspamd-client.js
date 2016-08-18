'use strict';

// streams through a message body and passes it to rspamd for checks

const Transform = require('stream').Transform;
const fetch = require('nodemailer-fetch');
const PassThrough = require('stream').PassThrough;

class RspamdClient extends Transform {
    constructor(options) {
        super();
        this.options = options || {};

        let headers = {
            from: options.from,
            rcpt: options.to,
            'queue-id': options.id
        };

        if (options.user) {
            headers.user = options.user;
        }

        this.body = new PassThrough();
        this.req = fetch(options.url, {
            method: 'post',
            contentType: 'message/rfc822',
            body: this.body,
            headers
        });
        this.req.once('error', err => {
            if (this.req.finished) {
                return;
            }
            this.req.finished = true;
            this.emit('fail', err);
        });

        this.chunks = [];
        this.chunklen = 0;
        this.req.on('readable', () => {
            let chunk;
            while ((chunk = this.req.read()) !== null) {
                this.chunks.push(chunk);
                this.chunklen += chunk.length;
            }
        });
    }

    _transform(chunk, encoding, callback) {
        if (!chunk || !chunk.length) {
            return callback();
        }

        if (typeof chunk === 'string') {
            chunk = new Buffer(chunk, encoding);
        }

        if (this.req.finished) {
            this.push(chunk);
            return callback();
        }

        this.push(chunk);
        if (this.body.write(chunk) === false) {
            return this.body.once('drain', () => {
                callback();
            });
        } else {
            return callback();
        }
    }

    _flush(callback) {
        if (this.req.finished) {
            return callback();
        }

        this.req.on('end', () => {
            if (this.req.finished) {
                return;
            }
            this.req.finished = true;
            let response = Buffer.concat(this.chunks, this.chunklen);

            try {
                response = JSON.parse(response.toString());
                this.emit('response', response);
            } catch (E) {
                this.emit('fail', E);
            }

            callback();
        });

        this.body.end();
    }
}

module.exports = RspamdClient;
