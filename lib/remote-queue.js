'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const db = require('./db');
const GridFSBucket = require('mongodb').GridFSBucket;
const { gelfCode, emitGelf } = require('./log-gelf');
const gridfsPending = require('./gridfs-pending');
const storeGridfs = require('./gridfs-store');

class RemoteQueue {
    constructor() {
        this.mongodb = false;
        this.gridstore = false;
        this.sendCommand = false;
    }

    store(id, stream, callback) {
        storeGridfs(this, config.queue.gfs, id, stream, callback, err => {
            // Match mail-drop's error classification: names ending in "Error" are storage
            // failures. SMTPResponse and ClientDisconnect describe submission outcomes and
            // belong at info level rather than in storage-failure alerts.
            if (/Error$/.test(err.name)) {
                log.error('StoreStream', '%s STREAMERR %s', id, err.message);
                emitGelf({
                    short_message: `${gelfCode('QUEUE_STORE_FAILED')} Failed to store message stream`,
                    full_message: err && err.stack ? err.stack : undefined,
                    _logger: 'StoreStream',
                    _message_id: id,
                    _error: err.message
                });
            } else if (err.name === 'ClientDisconnect') {
                log.info('StoreStream', '%s ABORTED %s', id, err.message);
            } else {
                log.info('StoreStream', '%s SMTPFAIL %s', id, err.message);
            }
        });
    }

    /**
     * Removes the marker for a stored message, once it is queued and belongs to something
     *
     * @param {ObjectId} filesId Identifier of the GridFS file
     * @param {Function} callback
     */
    clearPending(filesId, callback) {
        gridfsPending.clearPending(this.mongodb, config.queue.gfs, filesId, callback, 'writing');
    }

    /**
     * Ends an upload after queue insertion, keeping slow uploads protected from age-based GC
     *
     * @param {ObjectId} filesId Identifier of the GridFS file
     * @param {Function} callback
     */
    completePending(filesId, callback) {
        gridfsPending.completePending(this.mongodb, config.queue.gfs, filesId, callback);
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

    push(id, envelope, callback, filesId) {
        this.sendCommand(
            {
                cmd: 'PUSH',
                filesId: filesId && String(filesId),
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
