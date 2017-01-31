'use strict';

const config = require('config');
const GridFs = require('grid-fs');
const log = require('npmlog');
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;

class RemoteQueue {
    constructor() {
        this.mongodb = false;
        this.gridstore = false;
        this.sendCommand = false;
    }

    store(id, stream, callback) {
        let returned = false;
        let store = this.gridstore.createWriteStream('message ' + id, {
            fsync: true,
            content_type: 'message/rfc822',
            metadata: {
                created: new Date()
            }
        });

        stream.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;

            log.error('StoreStream', '%s STREAMERR %s', id, err.message);
            store.once('close', () => {
                log.info('StoreStream', '%s CLEANUP', id);
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

        store.on('close', () => {
            if (returned) {
                return;
            }
            returned = true;

            return callback(null, id);
        });

        stream.pipe(store);
    }

    setMeta(id, data, callback) {
        this.mongodb.collection(config.queue.gfs + '.files').findAndModify({
            filename: 'message ' + id
        }, false, {
            $set: {
                'metadata.data': data
            }
        }, {}, err => {
            if (err) {
                return callback(err);
            }
            return callback();
        });
    }

    push(id, envelope, callback) {
        this.sendCommand({
            cmd: 'PUSH',
            id,
            envelope
        }, callback);
    }

    retrieve(id) {
        return this.gridstore.createReadStream('message ' + id);
    }

    generateId(callback) {
        this.sendCommand('INDEX', callback);
    }

    removeMessage(id, callback) {
        this.sendCommand({
            cmd: 'REMOVE',
            id
        }, callback);
    }

    init(sendCommand, callback) {
        this.sendCommand = sendCommand;
        MongoClient.connect(config.queue.mongodb, (err, database) => {
            if (err) {
                log.error('Queue', 'Could not initialize MongoDB: %s', err.message);
                return;
            }

            this.mongodb = database;
            this.gridstore = new GridFs(this.mongodb, config.queue.gfs);
            return setImmediate(() => callback(null, true));
        });
    }
}

module.exports = RemoteQueue;
