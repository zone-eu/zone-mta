'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const db = require('./db');
const GridFSBucket = require('mongodb').GridFSBucket;
const { gelfCode, emitGelf } = require('./log-gelf');
const gridfsPending = require('./gridfs-pending');

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
            gridfsPending.stopPending(store.id);

            // Same test mail-drop uses: a name that does not end in "Error" is an outcome, not a
            // storage failure - an SMTP response a plugin chose, or a client that hung up.
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
            gridfsPending.stopPending(store.id);
            callback(err);
        });

        store.on('finish', () => {
            if (returned) {
                return;
            }
            returned = true;

            // The marker stays, and keeps beating. The files document exists, so the chunks are
            // reachable, but a stored message that never reaches the queue is nobody's: only the
            // caller knows when it is queued, so only the caller can say the marker has served
            // its purpose. The upload id goes with the callback for that, and the heartbeat
            // covers the scan and the push in between.
            return callback(null, id, store.id);
        });

        // The pipe below waits for the marker, so hold the source until then. Every caller
        // passes a stream nothing is reading yet, which is paused already, but a source that
        // had been flowing would lose whatever arrived while the marker was being written.
        stream.pause();

        // openUploadStream assigns the id above, but the files document is only inserted when
        // the stream finishes, so every chunk written in between belongs to nothing. The marker
        // is what makes that window recoverable, which is why it goes in before the first chunk
        // rather than along with them.
        gridfsPending.markPending(this.mongodb, config.queue.gfs, store.id, 'writing', err => {
            if (returned) {
                // The source gave up while the marker was being written and the error handler
                // above has already taken over. It ran before this heartbeat existed, so its
                // stopPending found nothing to stop and the timer is ours to cancel.
                gridfsPending.stopPending(store.id);
                return;
            }
            if (err) {
                returned = true;
                // Nothing was written through it, but the upload handle is open and nobody is
                // going to end it now.
                store.destroy();
                return callback(err);
            }
            stream.pipe(store);
        });
    }

    /**
     * Removes the marker for a stored message, once it is queued and belongs to something
     *
     * @param {ObjectId} filesId Identifier of the GridFS file
     * @param {Function} callback
     */
    clearPending(filesId, callback) {
        gridfsPending.clearPending(this.mongodb, config.queue.gfs, filesId, callback);
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
