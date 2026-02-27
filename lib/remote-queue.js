'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const db = require('./db');
const GridFSBucket = require('mongodb').GridFSBucket;
const { gelfCode, emitGelf } = require('./log-gelf');

class RemoteQueue {
    constructor() {
        this.mongodb = false;
        this.gridstore = false;
        this.sendCommand = false;
    }

    store(id, stream, callback) {
        let returned = false;
        let store = this.gridstore.openUploadStream('message ' + id, {
            contentType: 'message/rfc822',
            metadata: {
                created: new Date()
            }
        });

        stream.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;

            if (err.name !== 'SMTPResponse') {
                log.error('StoreStream', '%s STREAMERR %s', id, err.message);
                emitGelf({
                    short_message: `${gelfCode('QUEUE_STORE_FAILED')} Failed to store message stream`,
                    level: 4,
                    _stack: err && err.stack ? err.stack : undefined,
                    _logger: 'StoreStream',
                    _message_id: id,
                    _error: err.message
                });
            } else {
                log.info('StoreStream', '%s SMTPFAIL %s', id, err.message);
            }

            store.once('finish', () => {
                log.verbose('StoreStream', '%s CLEANUP', id);
                this.removeMessage(id, () => callback(err));
            });

            store.end();
        });

        store.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        });

        store.on('finish', () => {
            if (returned) {
                return;
            }
            returned = true;

            return callback(null, id);
        });

        stream.pipe(store);
    }

    setMeta(id, data, callback) {
        this.mongodb.collection(config.queue.gfs + '.files').updateOne(
            {
                filename: 'message ' + id
            },
            {
                $set: {
                    'metadata.data': data
                }
            },
            err => {
                if (err) {
                    return callback(err);
                }
                return callback();
            }
        );
    }

    push(id, envelope, callback) {
        this.sendCommand(
            {
                cmd: 'PUSH',
                id,
                envelope
            },
            callback
        );
    }

    retrieve(id) {
        return this.gridstore.openDownloadStreamByName('message ' + id);
    }

    generateId(callback) {
        this.sendCommand('INDEX', callback);
    }

    removeMessage(id, callback) {
        this.sendCommand(
            {
                cmd: 'REMOVE',
                id
            },
            callback
        );
    }

    init(sendCommand, callback) {
        this.sendCommand = sendCommand;
        db.connect(err => {
            if (err) {
                log.error('Queue/' + process.pid, 'Could not initialize database: %s', err.message);
                emitGelf({
                    short_message: `${gelfCode('QUEUE_DB_INIT_FAILED')} Could not initialize queue database`,
                    level: 3,
                    full_message: err && err.stack ? err.stack : undefined,
                    _logger: 'Queue/' + process.pid,
                    _pid: process.pid,
                    _error: err.message
                });
                return process.exit(1);
            }

            this.mongodb = db.senderDb;
            this.gridstore = new GridFSBucket(this.mongodb, {
                bucketName: config.queue.gfs
            });

            return setImmediate(() => callback(null, true));
        });
    }
}

module.exports = RemoteQueue;
