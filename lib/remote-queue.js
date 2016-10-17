'use strict';

const config = require('config');
const log = require('npmlog');
const fetch = require('nodemailer-fetch');

class RemoteQueue {
    constructor(sendCommand) {
        this.sendCommand = sendCommand;
    }

    store(id, stream, callback) {
        let returned = false;
        let req = fetch('http://' + config.api.hostname + ':' + config.api.port + '/store/' + id, {
            method: 'put',
            contentType: 'application/octet-stream',
            body: stream,
            allowErrorResponse: true
        });

        req.once('error', err => {
            if (returned) {
                log.error('Upload', '%s UPLOADFAIL %s', id, err.message);
                return;
            }
            returned = true;
            callback(err);
        });

        let chunks = [];
        let chunklen = 0;
        req.on('readable', () => {
            let chunk;
            while ((chunk = req.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        });

        req.on('end', () => {
            if (returned) {
                return;
            }
            returned = true;

            let data;

            try {
                data = JSON.parse(Buffer.concat(chunks, chunklen).toString());
            } catch (E) {
                log.error('Upload', '%s PARSEFAIL %s', id, E.message);
                return callback(new Error('Failed storing message to queue'));
            }

            if (/Error$/.test(data.code)) {
                // Restify error
                log.error('Upload', '%s ERESTIFY %s: %s', id, data.code, data.message);
                return callback(new Error('Failed storing message to queue'));
            }

            if (data.error || !data.success) {
                let err = new Error(data.error || 'Failed storing message to queue');
                if (data.responseCode) {
                    err.responseCode = data.responseCode;
                }
                return callback(err);
            }

            return callback(null, true);
        });
    }

    setMeta(id, data, callback) {
        this.sendCommand({
            cmd: 'SETMETA',
            id,
            data
        }, callback);
    }

    push(id, envelope, callback) {
        this.sendCommand({
            cmd: 'PUSH',
            id,
            envelope
        }, callback);
    }

    generateId(callback) {
        this.sendCommand('INDEX', callback);
    }
}

module.exports = RemoteQueue;
