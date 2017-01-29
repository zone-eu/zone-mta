'use strict';

const config = require('config');
const GridFs = require('grid-fs');

class RemoteQueue {
    constructor(mongodb, sendCommand) {
        this.mongodb = mongodb;
        this.gridstore = new GridFs(this.mongodb, config.queue.gfs);
        this.sendCommand = sendCommand;
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
            this.removeMessage(id, () => callback(err));
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

    generateId(callback) {
        this.sendCommand('INDEX', callback);
    }

    removeMessage(id, callback) {
        this.sendCommand({
            cmd: 'REMOVE',
            id
        }, callback);
    }
}

module.exports = RemoteQueue;
