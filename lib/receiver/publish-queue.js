'use strict';

const EventEmitter = require('events');
const config = require('config');
const GridFs = require('grid-fs');
const log = require('npmlog');
const mongodb = require('mongodb');
const zones = require('./zones');
const MongoClient = mongodb.MongoClient;
const amqplib = require('amqplib/callback_api');

class PublishQueue extends EventEmitter {

    constructor(exchange) {
        super();
        this.exchange = exchange || 'default';
        this.mongodb = false;
        this.gridstore = false;
        this.remoteClient = false;
        this.amqp = false;
        this.channel = false;
        this.offlineQueue = [];
        this.opening = false;
    }

    // retrieve an ID from the master process
    generateId(callback) {
        this.remoteClient('INDEX', callback);
    }

    // stores a stream to queue database
    store(id, stream, callback) {
        let returned = false;
        let store = this.gridstore.createWriteStream('raw-' + id + '.eml', {
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
            filename: 'raw-' + id + '.eml'
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
        envelope = envelope || {};

        let recipients = [].concat(envelope.to || []);
        let zone = envelope.sendingZone;

        if (!recipients.length) {
            return setImmediate(() => callback(new Error('Empty recipients list')));
        }

        if (zone && !zones.list.has(zone)) {
            // no such Zone available, use default
            zone = false;
        }

        let seq = 0;
        let pos = 0;
        // split recipient list into separate deliveries. We do not use a loop in case there is a large
        // set of recipients to handle
        let processRecipients = () => {
            if (pos >= recipients.length) {
                return setImmediate(() => callback(null, id));
            }
            let recipient = recipients[pos++];
            let deliveryZone;
            let recipientDomain = recipient.substr(recipient.lastIndexOf('@') + 1).replace(/[\[\]]/g, '');
            let senderDomain = (envelope.headers.from || envelope.from || '').split('@').pop();

            deliveryZone = zone;

            // try to route by From domain
            if (!deliveryZone && senderDomain) {
                // if sender domain is not routed, then returns false
                deliveryZone = zones.findBySender(senderDomain);
                if (deliveryZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s:%s by sender %s', deliveryZone, id, recipient, senderDomain);
                }
            }

            // try to route by recipient domain
            if (!deliveryZone && recipientDomain) {
                // if recipient domain is not routed, then returns false
                deliveryZone = zones.findByRecipient(recipientDomain);
                if (deliveryZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s:%s by recipient %s', deliveryZone, id, recipient, recipientDomain);
                }
            }

            // try to route by origin address
            if (!deliveryZone && envelope.origin) {
                deliveryZone = zones.findByOrigin(envelope.origin);
                if (deliveryZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s:%s by origin %s', deliveryZone, id, recipient, envelope.origin);
                }
            }

            // still nothing, use default
            if (!deliveryZone) {
                deliveryZone = 'default';
            }

            seq++;
            let deliverySeq = (seq < 0x100 ? '0' : '') + (seq < 0x10 ? '0' : '') + seq.toString(16);
            let delivery = {
                id,
                seq: deliverySeq,

                // Actual delivery data
                domain: recipientDomain,
                sendingZone: deliveryZone,

                // actual recipient address
                recipient
            };

            this.publish(delivery);

            return setImmediate(processRecipients);

        };
        processRecipients();
    }


    removeMessage(id, callback) {
        log.verbose('Queue', '%s REMOVE', id);
        this.gridstore.unlink('raw-' + id + '.eml', callback);
    }


    setupPublisher() {
        if (this.opening || this.channel) {
            return;
        }
        this.opening = true;
        this.amqp.createChannel((err, channel) => {
            this.opening = false;
            if (err) {
                return this.emit('error', err);
            }
            this.channel = channel;

            this.channel.once('error', err => {
                log.error('AMQP', 'Channel error. %s', err.message);
                if (!this.opening) {
                    this.channel = false;
                    this.offlineQueue = [];
                }
            });

            this.channel.on('close', () => {
                log.info('AMQP', 'Channel closed');
                if (!this.opening) {
                    this.channel = false;
                    this.offlineQueue = [];
                }
            });

            this.channel.assertQueue(this.exchange);

            while (this.offlineQueue.length) {
                let args = this.offlineQueue.shift();
                this.publish(...args);
            }

            setImmediate(() => this.emit('amqppublisher'));
        });
    }

    publish(content) {
        if (!this.channel) {
            this.offlineQueue.push([content]);
            return this.setupPublisher();
        }
        this.channel.sendToQueue(this.exchange,
            Buffer.from(JSON.stringify(content)), {
                persistent: true,
                contentType: 'application/json'
            });
    }


    init(remoteClient, callback) {
        this.remoteClient = remoteClient;
        MongoClient.connect(config.queue.mongodb, (err, database) => {
            if (err) {
                log.error('Queue', 'Could not initialize MongoDB: %s', err.message);
                return;
            }

            this.mongodb = database;
            this.gridstore = new GridFs(this.mongodb, config.queue.gfs);

            amqplib.connect(config.queue.amqp, (err, conn) => {
                if (err) {
                    log.error('Queue', 'Could not initialize AMQP: %s', err.message);
                    this.mongodb.close();
                    return;
                }

                this.amqp = conn;

                return setImmediate(() => callback(null, true));
            });
        });
    }
}

module.exports = PublishQueue;
