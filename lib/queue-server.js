'use strict';

const config = require('config');
const log = require('npmlog');
const Server = require('./transport/server');
const SeqIndex = require('seq-index');
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const GridFs = require('grid-fs');

class QueueServer {

    constructor() {
        this.seqIndex = new SeqIndex();
        this.closing = false;
        this.clients = new WeakMap();
        this.mongodb = false;
        this.gridstore = false;
        this.garbageTimer = null;

        this.createServer();
    }

    generateId() {
        return this.seqIndex.get();
    }

    createServer() {
        this.server = new Server();
        this.server.on('client', client => {

            client.responseHandlers = new Map();
            client.smtp = false;
            client.id = false;

            client.on('close', () => {
                client = null;
            });

            client.once('error', () => {
                client = null;
            });

            client.onData = (data, next) => {
                setImmediate(next); // release immediatelly

                if (!client) {
                    // client already errored or closed
                    return;
                }

                if (data.cmd === 'HELLO') {
                    client.id = data.id;
                    // everything OK
                    return;
                }

                if (!data.req) {
                    // ignore
                    return;
                }

                switch (data.cmd) {
                    // we use shared index generator
                    case 'INDEX':
                        client.send({
                            req: data.req,
                            response: this.generateId()
                        });
                        break;

                    case 'NOOP':
                        client.send({
                            req: data.req,
                            response: true
                        });
                        break;
                }
            };

        });
    }

    // remove old messages from MongoDB. Normally messages should be deleted once sent or rejected but on some conditions
    // the message might be not cleared
    clearGarbage(callback) {
        let clearUntil = Date.now() - 3 * 24 * 3600 * 1000; // anything older than last 3 days
        let firstObjectId = false;
        let deleted = 0;

        let collection = this.mongodb.collection(config.queue.gfs + '.files');
        collection.find({
            uploadDate: {
                $lte: new Date(clearUntil)
            }
        }, {
            _id: true,
            filename: true
        }, {}, (err, cursor) => {
            if (err) {
                return callback(err);
            }

            let deleteNext = () => {
                cursor.nextObject((err, doc) => {
                    if (err) {
                        return callback(err);
                    }
                    if (!doc) {
                        if (deleted) {
                            log.verbose('GC', 'Cleared %s expired files from GridStore', deleted);
                        }
                        return cursor.close(() => {
                            if (!firstObjectId) {
                                return callback();
                            }
                            // delete orphan chunks
                            this.mongodb.collection(config.queue.gfs + '.chunks').deleteMany({
                                _id: {
                                    $lte: firstObjectId
                                }
                            }, callback);
                        });
                    }
                    if (!firstObjectId) {
                        firstObjectId = doc._id;
                    }
                    log.verbose('GC', '%s DELEXPIRED', doc.filename.split(' ').pop());
                    this.gridstore.unlink(doc.filename, err => {
                        if (err) {
                            return cursor.close(() => callback(err));
                        }
                        deleted++;
                        deleteNext();
                    });
                });
            };
            deleteNext();
        });
    }

    /**
     * Method that perdiodically checks and removes garbage
     */
    checkGarbage() {
        clearTimeout(this.garbageTimer);
        let startTimer = Date.now();
        this.clearGarbage(err => {
            let timeDiff = (Date.now() - startTimer) / 1000;
            if (err) {
                log.error('GC', '[%ss] %s', timeDiff, err.message);
            } else if (timeDiff > 1.0) {
                log.info('GC', 'Garbage collecting duration %ss', timeDiff);
            }
            this.garbageTimer = setTimeout(() => this.checkGarbage(), 10 * 1000);
            this.garbageTimer.unref();
        });
    }

    stopPeriodicCheck() {
        clearTimeout(this.garbageTimer);
        this.garbageTimer = null;
    }

    startPeriodicCheck() {
        this.stopPeriodicCheck();
        this.garbageTimer = setTimeout(() => this.checkGarbage(), 10 * 1000);
        this.garbageTimer.unref();
    }

    start(callback) {
        let returned = false;
        this.server.once('error', err => {
            if (returned) {
                return log.error('QS', err);
            }
            returned = true;
            return callback(err);
        });

        MongoClient.connect(config.queue.mongodb, (err, database) => {
            if (err) {
                log.error('Queue', 'Could not initialize MongoDB: %s', err.message);
                return;
            }

            this.mongodb = database;
            this.gridstore = new GridFs(this.mongodb, config.queue.gfs);

            this.mongodb.ensureIndex(config.queue.gfs + '.files', {
                uploadDate: -1
            }, () => {
                this.server.listen(config.queueServer.port, config.queueServer.host, () => {
                    if (returned) {
                        return this.server.close();
                    }
                    returned = true;
                    this.startPeriodicCheck();
                    callback(null, true);
                });
            });
        });
    }

    close(callback) {
        this.closing = true;
        this.server.close(() => {
            if (this.mongodb) {
                return this.mongodb.close(() => callback);
            }
            callback();
        });
    }
}

module.exports = QueueServer;
