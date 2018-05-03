'use strict';

const log = require('npmlog');
const sendingZone = require('./sending-zone');
const EventEmitter = require('events');
const SeqIndex = require('seq-index');
const QueueLocker = require('./queue-locker');
const TtlCache = require('./ttl-cache');
const crypto = require('crypto');
const plugins = require('./plugins');
const db = require('./db');
const GridFSBucket = require('mongodb').GridFSBucket;
const internalCounters = require('./counters');
const yaml = require('js-yaml');
const fs = require('fs');
const pathlib = require('path');
const setupIndexes = yaml.safeLoad(fs.readFileSync(pathlib.join(__dirname, '..', 'indexes.yaml'), 'utf8'));

const promClient = require('prom-client');
const queueSizeGauge = new promClient.Gauge({
    name: 'zonemta_queue_size',
    help: 'Current size of the queue',
    labelNames: ['type']
});
const blacklistedGauge = new promClient.Gauge({
    name: 'zonemta_blacklisted',
    help: 'Blacklisted addresses'
});

/**
 * MailQueue class for generating mail queue instances. These instances handle
 * storing and retrieving emails and delivery data from a MongoDB database
 */
class MailQueue {
    /**
     * Initializes a new MailQueue object
     *
     * @constructor
     * @param {Object} options Instance options
     */
    constructor(options) {
        this.options = options || {};
        this.instanceId = this.options.instanceId || 'default';
        this.mongodb = false;
        this.gridstore = false;
        this.closing = false;
        this.garbageTimer = null;
        this.seqIndex = new SeqIndex();

        this.cache = new TtlCache(); // shared cache for workers
        this.locks = new QueueLocker();
    }

    /**
     * Stores a stream (eg. an email message) into the backend storage
     *
     * @param  {Stream}   stream   Stream data to store
     * @param  {Function} callback Returns with (err, id)
     */
    store(id, stream, callback) {
        if (this.closing) {
            // nothing to do here
            return callback(new Error('Server shutdown in progress'));
        }

        id = id || this.seqIndex.get();
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

            store.once('finish', () => {
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

    /**
     * Set metadata for a message
     *
     * @param {String} id The ID of the stored data
     * @param {Object} data Data to store as metadata for the stream
     * @param {Function} callback
     */
    setMeta(id, data, callback) {
        this.mongodb.collection(this.options.gfs + '.files').findAndModify(
            {
                filename: 'message ' + id
            },
            false,
            {
                $set: {
                    'metadata.data': data
                }
            },
            {},
            err => {
                if (err) {
                    return callback(err);
                }
                return callback();
            }
        );
    }

    /**
     * Get metadata for a message
     *
     * @param {String} id The ID of the stored data
     * @param {Function} callback Returns the stored metadata as an object
     */
    getMeta(id, callback) {
        this.mongodb.collection(this.options.gfs + '.files').findOne(
            {
                filename: 'message ' + id
            },
            (err, item) => {
                if (err) {
                    return callback(err);
                }

                if (!item) {
                    return callback(null, false);
                }

                return callback(null, (item && item.metadata && item.metadata.data) || {});
            }
        );
    }

    /**
     * Creates a read stream from the backend storage
     *
     * @param  {String} id Id of the stored data
     * @return {Stream} Stream
     */
    retrieve(id) {
        return this.gridstore.openDownloadStreamByName('message ' + id);
    }

    /**
     * Pushes deliveries for a message to the queue
     *
     * @param {String} id Message id (retrieved from the store() method)
     * @param {Object} envelope Values to store in the delivery object
     * @param {String} envelope.from The address of the sender
     * @param {Array} envelope.to An array of recipient addresses
     * @param {Array} envelope.sendingZone The identifier of the Sending Zone to use for this message
     * @param {Array} envelope.origin IP address of the sender
     * @param {Mixed} envelope[] Any other value you need to store for the delivery
     * @param  {Function} callback [description]
     */
    push(id, envelope, callback) {
        let ev = new EventEmitter();

        if (this.closing) {
            // nothing to do here
            return callback(new Error('Server shutdown in progress'));
        }

        envelope = envelope || {};

        let recipients = [].concat(envelope.to || []);
        let zone = envelope.sendingZone;

        if (!recipients.length) {
            return setImmediate(() => callback(new Error('Empty recipients list')));
        }

        if (zone && !sendingZone.get(zone)) {
            // no such Zone available, use default
            zone = false;
        }

        let inserted = [];
        let seq = 0;
        let documents = [];

        // function to insert the batch values
        let recipientsProcessed = () => {
            // Store deliveries.
            //
            // Depending on the amount of recipients this can be a huge batch.
            // We can't do this sequentially but in batch, otherwise we might end up with dirty data
            // where some deliveries are marked already as queued when we need to return an error and
            // fail the entire message
            //
            // Alternative to huge batches would be using some kind of a marker for a message id that needs
            // to be set when we fetch items from the queue for delivery. If we also lock the queue items then
            // it wouldn't make queues too much slower (although it would make everything a lot more complex)
            internalCounters.count('delivery:push');

            let collection = this.mongodb.collection(this.options.collection);
            collection.insertMany(
                documents,
                {
                    w: 1,
                    ordered: false
                },
                err => {
                    if (err) {
                        return callback(err);
                    }

                    callback(null, id);
                }
            );
        };

        let pos = 0;
        // split recipient list into separate deliveries. We do not use a loop in case there is a large
        // set of recipients to handle
        let processRecipients = () => {
            if (pos >= recipients.length) {
                return setImmediate(recipientsProcessed);
            }
            let recipient = recipients[pos++];
            let deliveryZone;
            let recipientDomain = recipient.substr(recipient.lastIndexOf('@') + 1).replace(/[[\]]/g, '');
            let senderDomain = (envelope.headers.from || envelope.from || '').split('@').pop();

            deliveryZone = zone;

            // try to route by From domain
            if (!deliveryZone && senderDomain) {
                // if sender domain is not routed, then returns false
                deliveryZone = sendingZone.findBySender(senderDomain);
                if (deliveryZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s:%s by sender %s', deliveryZone, id, recipient, senderDomain);
                }
            }

            // try to route by recipient domain
            if (!deliveryZone && recipientDomain) {
                // if recipient domain is not routed, then returns false
                deliveryZone = sendingZone.findByRecipient(recipientDomain);
                if (deliveryZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s:%s by recipient %s', deliveryZone, id, recipient, recipientDomain);
                }
            }

            // try to route by origin address
            if (!deliveryZone && envelope.origin) {
                deliveryZone = sendingZone.findByOrigin(envelope.origin);
                if (deliveryZone) {
                    log.verbose('Queue', 'Detected Zone %s for %s:%s by origin %s', deliveryZone, id, recipient, envelope.origin);
                }
            }

            // still nothing, use default
            if (!deliveryZone) {
                deliveryZone = 'default';
            }

            let routing = {
                recipient,
                deliveryZone
            };

            plugins.handler.runHooks('queue:route', [envelope, routing], err => {
                if (err) {
                    return callback(err);
                }
                recipient = routing.recipient;
                deliveryZone = routing.deliveryZone;

                seq++;
                let date = new Date();
                let deliverySeq = (seq < 0x100 ? '0' : '') + (seq < 0x10 ? '0' : '') + seq.toString(16);
                let delivery = {
                    id,
                    seq: deliverySeq,

                    // Actual delivery data
                    domain: recipientDomain,
                    sendingZone: deliveryZone,

                    // actual recipient address
                    recipient,

                    locked: false,
                    lockTime: 0,
                    assigned: 'no',

                    // earliest time to attempt delivery, defaults to now
                    queued: date,

                    // queued date might change but created should not
                    created: date
                };

                if (envelope.deferDelivery && envelope.deferDelivery > Date.now()) {
                    // Setup defer data
                    delivery._deferred = delivery._deferred || {
                        first: Date.now(),
                        count: 0
                    };
                    delivery._deferred.last = Date.now();
                    delivery._deferred.next = envelope.deferDelivery;
                    delivery._deferred.response = 'Deferred by router';

                    delivery.queued = new Date(envelope.deferDelivery);
                }

                documents.push(delivery);

                // emit an event about the new element
                ev.emit('queued', {
                    event: 'queued',
                    id: delivery.id + '.' + delivery.seq,
                    time: Date.now(),
                    zone: delivery.sendingZone,
                    messageId: envelope.messageId,
                    from: envelope.from,
                    recipient: delivery.recipient,
                    source: envelope.origin
                });

                inserted.push({
                    zone: delivery.sendingZone,
                    domain: recipientDomain,
                    deferred: !!envelope.deferDelivery
                });

                return setImmediate(processRecipients);
            });
        };

        processRecipients();
        return ev;
    }

    /**
     * Get next delivery for a Zone. If a domain is set then prefers messages to that domain
     *
     * @param {String} zone Identifier of the Sending Zone
     * @param {Object} [options] optional options objects
     * @param {String} [options.domain] If set prefer deliveries to that domain
     * @param {Boolean} [options.toDomainOnly] If true, then does not look for alternative deliveries once there are none left for the selected domain
     * @param {Function} callback Callback to run with the delivery object
     */
    shift(zone, options, callback) {
        if (!callback && typeof options === 'function') {
            callback = options;
            options = false;
        }

        if (this.closing) {
            // nothing to do here
            return callback(null, false);
        }

        zone = zone || 'default';
        options = options || {};

        if (this.cache.get('empty:' + zone)) {
            return setImmediate(() => callback(null, false));
        }

        let lockOwner = options.lockOwner || false;
        let getDomainConfig = options.getDomainConfig || (() => false);

        let collection = this.mongodb.collection(this.options.collection);
        let query = {
            sendingZone: zone,
            queued: {
                $lte: new Date()
            },
            locked: false,
            $or: [
                {
                    assigned: 'no'
                },
                {
                    assigned: this.instanceId
                }
            ]
        };
        let skipDomains = this.locks.listSkipDomains(zone);
        if (skipDomains && skipDomains.length) {
            query.domain = {
                $nin: skipDomains
            };
        }

        let tryNext = () => {
            collection.findOneAndUpdate(
                query,
                {
                    $set: {
                        locked: true,
                        lockTime: Date.now(),
                        assigned: this.instanceId
                    }
                },
                {
                    returnOriginal: false
                },
                (err, item) => {
                    if (err) {
                        return callback(err);
                    }

                    if (!item || !item.value) {
                        // nothing found, disable this zone for few seconds
                        this.cache.set('empty:' + zone, true, 5 * 1000);
                        return setImmediate(() => callback(null, false));
                    }

                    let delivery = item.value;

                    let lockKey = 'lock ' + delivery.id + ' ' + delivery.seq;
                    let maxConnections = Number(getDomainConfig(delivery.domain, 'maxConnections')) || 5;

                    // Check if the key is already locked
                    // Lock TTL is relatively high, this is because if the MX has several IP addresses and
                    // all of them refuse to accept connections then connecting to all possible IPs might take time
                    let lockTtl = 60 * 60 * 1000;
                    if (!this.locks.lock(lockKey, zone, delivery.domain, lockOwner, maxConnections, lockTtl)) {
                        // nothing to do here, already locked by someone else
                        return setImmediate(tryNext);
                    }

                    delivery._lock = lockKey;

                    this.getMeta(delivery.id, (err, meta) => {
                        if (err) {
                            this.locks.release(delivery._lock);
                            return callback(err);
                        }

                        if (!meta) {
                            // this message has been already deleted, so remove the
                            // queue entries as well
                            return collection.deleteMany(
                                {
                                    id: delivery.id
                                },
                                () => {
                                    this.locks.release(delivery._lock);
                                    plugins.handler.remotelog(delivery.id, false, 'DELETED', {
                                        reason: 'Not found from GridStore'
                                    });
                                    // try to find another delivery
                                    return setImmediate(tryNext);
                                }
                            );
                        }

                        Object.keys(meta || {}).forEach(key => {
                            delivery[key] = meta[key];
                        });

                        let data = {};
                        Object.keys(delivery).forEach(key => {
                            if (!data.hasOwnProperty(key)) {
                                data[key] = delivery[key];
                            }
                        });

                        log.verbose('Queue', '%s.%s SHIFTED (key="%s" zone="%s")', delivery.id, delivery.seq, lockKey, zone);

                        this.mongodb.collection('suppressionlist').findOne(
                            {
                                $or: [
                                    {
                                        address: (delivery.recipient || '').toLowerCase().trim()
                                    },
                                    {
                                        domain: delivery.domain
                                    }
                                ]
                            },
                            (err, suppressed) => {
                                if (err) {
                                    // just ignore, not important, even though should not happen
                                }
                                if (suppressed) {
                                    return this.releaseDelivery(delivery, err => {
                                        if (err) {
                                            this.locks.release(delivery._lock);
                                            return callback(err);
                                        }
                                        log.info(
                                            'Queue',
                                            '%s.%s DROP[suppressed] Recipient %s was found from suppression list',
                                            delivery.id,
                                            delivery.seq,
                                            delivery.recipient
                                        );

                                        let suppresskey = '';
                                        let suppressvalue = '';

                                        if (suppressed.address && (delivery.recipient || '').toLowerCase().trim() === suppressed.address) {
                                            suppresskey = 'suppressed address';
                                            suppressvalue = suppressed.address;
                                        } else if (suppressed.domain && delivery.domain === suppressed.domain) {
                                            suppresskey = 'suppressed domain';
                                            suppressvalue = suppressed.domain;
                                        }

                                        plugins.handler.remotelog(delivery.id, delivery.seq, 'DROP', {
                                            reason: 'Recipient was found from suppression list',
                                            recipient: delivery.recipient,
                                            [suppresskey]: suppressvalue
                                        });

                                        // try to find another delivery
                                        return setImmediate(tryNext);
                                    });
                                }

                                return callback(null, delivery);
                            }
                        );
                    });
                }
            );
        };

        setImmediate(tryNext);
    }

    /**
     * Deletes a delivery or message group
     *
     * @param {String} id Queue ID
     * @param {String} [seq] Optional delivery sequence ID
     */
    remove(id, seq, callback) {
        let query = {
            id
        };

        // 'seq ' + id + ' ' + deliverySeq
        if (seq) {
            query.seq = seq;
        }

        // every delete opration gets an unique ID, so if we fail, we can release locked deliveries
        let deleteId = 'delete:' + crypto.randomBytes(10).toString('base64');

        let collection = this.mongodb.collection(this.options.collection);
        collection.find(
            query,
            {
                _id: true,
                id: true,
                seq: true
            },
            {},
            (err, cursor) => {
                if (err) {
                    return callback(err);
                }

                let releaseNext = () => {
                    cursor.nextObject((err, delivery) => {
                        if (err) {
                            this.locks.releaseLockOwner(deleteId);
                            return callback(err);
                        }
                        if (!delivery) {
                            return cursor.close(callback);
                        }

                        delivery._lock = 'lock ' + delivery.id + ' ' + delivery.seq;
                        if (!this.locks.lock(delivery._lock, delivery.zoneName, false, deleteId, 0, 1 * 60 * 1000)) {
                            // can't delete, already locked by someone else
                            log.info('Delete', '%s.%s DELFAIL Delivery entry already locked, skipping', delivery.id, delivery.seq);
                            return releaseNext();
                        }

                        delivery.skipDelayDelete = true;
                        this.releaseDelivery(delivery, err => {
                            if (err) {
                                log.error('Delete', '%s.%s DELERROR %s', delivery.id, delivery.seq, err.message);
                            } else {
                                log.info('Delete', '%s.%s DELSUCCESS Delivery entry deleted', delivery.id, delivery.seq);
                                plugins.handler.remotelog(delivery.id, delivery.seq, 'DELETED', {
                                    reason: 'Deletion requested from API'
                                });
                            }
                            releaseNext();
                        });
                    });
                };

                setImmediate(releaseNext);
            }
        );
    }

    /**
     * Update a message entry
     *
     * @param {String} id Queue ID
     * @param {String} [seq] Optional delivery sequence ID
     */
    update(id, seq, update, callback) {
        let query = {
            id
        };

        if (seq) {
            query.seq = seq;
        }

        let collection = this.mongodb.collection(this.options.collection);
        collection.updateMany(
            query,
            update,
            {
                w: 1,
                multi: true
            },
            (err, r) => {
                if (err) {
                    return callback(err);
                }

                return callback(null, r.result.n);
            }
        );
    }

    /**
     * Retrieves a delivery by message ID and sequence number
     *
     * @param {String/Number} id Message ID
     * @param {String} seq Sequence number (0-padded hex, at least 3 symbols)
     * @param {Function} callback Returns the delivery object
     */
    getDelivery(id, seq, callback) {
        let collection = this.mongodb.collection(this.options.collection);
        collection.findOne(
            {
                id,
                seq
            },
            (err, item) => {
                if (err) {
                    return callback(err);
                }
                return callback(null, item || false);
            }
        );
    }

    /**
     * Removes a delivery from the queue. This happens when a message is delivered or it bounces
     *
     * @param {Object} delivery Message object
     * @param {Function} callback Run once the message is removed from the queue
     */
    releaseDelivery(delivery, callback) {
        let collection = this.mongodb.collection(this.options.collection);
        collection.deleteOne(
            {
                id: delivery.id,
                seq: delivery.seq
            },
            err => {
                // whatever happened, no need to hold the lock anymore
                this.locks.release(delivery._lock);

                if (err) {
                    return callback(err);
                }

                // Try to find a delivery reference for the message body. If references
                // are not found then this message body is no longer needed and can be deleted
                collection.findOne(
                    {
                        id: delivery.id
                    },
                    {
                        fields: {
                            id: 1,
                            seq: 1
                        }
                    },
                    (err, entry) => {
                        if (err) {
                            return callback(err);
                        }

                        if (entry) {
                            // still deliveries left for this message, do not delete yet
                            return callback(null, false);
                        }

                        // no pending references, safe to remove the stored message
                        log.verbose('Queue', 'Deleting unreferenced message %s', delivery.id);
                        this.removeMessage(delivery.id, err => callback(null, !err));
                    }
                );
            }
        );
    }

    /**
     * Method that marks a message as deferred. This message is removed from the active queued
     *
     * @param {Object} delivery Message object
     * @param {Number} ttl TTL in ms. Once this time is over the message is reinserted to queue
     * @param {Number} responseData SMTP response or description
     * @param {Function} callback Run once the message is removed from active queue
     */
    deferDelivery(delivery, ttl, responseData, callback) {
        // add metainfo about postponing the delivery
        delivery._deferred = delivery._deferred || {
            first: Date.now(),
            count: 0
        };
        delivery._deferred.count++;
        delivery._deferred.last = Date.now();
        delivery._deferred.next = Date.now() + ttl;
        delivery._deferred.response = responseData.response;
        delivery._deferred.log = responseData.log || delivery._deferred.log;
        delivery.queued = new Date(Math.max(delivery._deferred.next, Date.now()));
        delivery.locked = false;

        let collection = this.mongodb.collection(this.options.collection);
        collection.findOneAndUpdate(
            {
                id: delivery.id,
                seq: delivery.seq
            },
            {
                $set: {
                    _deferred: delivery._deferred,
                    queued: delivery.queued,
                    locked: false
                }
            },
            {},
            err => {
                if (err) {
                    return callback(err);
                }

                // safe to remove the lock
                log.verbose('Queue', '%s.%s UNLOCK (key="%s")', delivery.id, delivery.seq, delivery._lock);
                this.locks.release(delivery._lock);

                return callback(null, true);
            }
        );
    }

    /**
     * Retrieves info about currently queued deliveries for a queue ID
     */
    getInfo(id, callback) {
        this.mongodb
            .collection(this.options.collection)
            .find({
                id
            })
            .sort({
                seq: 1
            })
            .toArray((err, deliveries) => {
                if (err) {
                    return callback(err);
                }

                if (!deliveries || !deliveries.length) {
                    return callback(null, false);
                }

                this.getMeta(id, (err, meta) => {
                    if (err) {
                        return callback(err);
                    }
                    let curtime = Date.now();

                    let messages = deliveries.map(delivery => {
                        let deferred = delivery.queued > curtime;
                        let message = {
                            id,
                            seq: delivery.seq,
                            zone: delivery.sendingZone,
                            recipient: delivery.recipient,
                            status: deferred ? 'DEFERRED' : 'QUEUED',
                            lock: this.locks.locks.get('lock ' + delivery.id + ' ' + delivery.seq)
                        };
                        if (deferred) {
                            message.deferred = delivery._deferred;
                        }
                        return message;
                    });

                    callback(null, {
                        meta,
                        messages
                    });
                });
            });
    }

    /**
     * Removes message remains from the db
     */
    removeMessage(id, callback) {
        log.verbose('Queue', '%s REMOVE', id);
        this.mongodb.collection(this.options.gfs + '.files').findOne(
            {
                filename: 'message ' + id
            },
            (err, entry) => {
                if (err) {
                    return callback(err);
                }
                if (!entry) {
                    return callback(null, false);
                }
                this.gridstore.delete(entry._id, callback);
            }
        );
    }

    clearGarbage(callback) {
        let collection = this.mongodb.collection(this.options.collection);

        // clear message locks
        collection.updateMany(
            {
                locked: true,
                assigned: this.instanceId,
                lockTime: {
                    // keep lockTTL on par with in-memory-locks (+1min)
                    $lte: Date.now() - 61 * 60 * 1000
                }
            },
            {
                $set: {
                    locked: false,
                    lockTime: 0
                }
            },
            {
                w: 1,
                multi: true
            },
            (err, r) => {
                if (err) {
                    return callback(err);
                }

                if (r.result.n) {
                    log.verbose('GC', 'Released %s expired locks for queued messages', r.result.n);
                }

                collection.findOne(
                    {},
                    {
                        sort: [['created', 1]],
                        fields: {
                            created: 1
                        }
                    },
                    (err, delivery) => {
                        if (err) {
                            return callback(err);
                        }

                        let clearUntil;
                        if (!delivery) {
                            // if message queue is empty delete everything older than 10 minutes
                            clearUntil = Date.now();
                        } else {
                            clearUntil = Number(delivery.created && delivery.created.getTime && delivery.created.getTime());
                        }

                        if (!clearUntil) {
                            // safe bet in case the first refKey returned something strange
                            clearUntil = Date.now() - 10 * 24 * 3600 * 1000; // anything older than last 10 days
                        } else {
                            // remove messages stored before 10 minutes of the first id
                            clearUntil -= 10 * 60 * 1000;
                        }

                        let firstObjectId = false;
                        let deleted = 0;

                        let query = {
                            uploadDate: {
                                $lte: new Date(clearUntil)
                            }
                        };

                        let cursor = this.mongodb
                            .collection(this.options.gfs + '.files')
                            .find(query)
                            .project({
                                _id: true,
                                filename: true
                            });

                        let deleteNext = () => {
                            cursor.next((err, doc) => {
                                if (err) {
                                    return callback(err);
                                }
                                if (!doc) {
                                    if (deleted) {
                                        log.info('GC', 'Cleared %s expired files from GridStore', deleted);
                                    }
                                    return cursor.close(() => {
                                        if (!firstObjectId) {
                                            return callback();
                                        }
                                        // delete orphan chunks (should not exist, just in case)
                                        this.mongodb.collection(this.options.gfs + '.chunks').deleteMany(
                                            {
                                                _id: {
                                                    $lte: firstObjectId
                                                }
                                            },
                                            callback
                                        );
                                    });
                                }
                                if (!firstObjectId) {
                                    firstObjectId = doc._id;
                                }
                                log.verbose('GC', '%s DELEXPIRED', doc.filename.split(' ').pop());
                                this.gridstore.delete(doc._id, err => {
                                    if (err) {
                                        return cursor.close(() => callback(err));
                                    }
                                    deleted++;
                                    deleteNext();
                                });
                            });
                        };
                        deleteNext();
                    }
                );
            }
        );
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

    queuCounterUpdate() {
        clearTimeout(this.queuCounterTimer);

        let next = () => {
            this.queuCounterTimer = setTimeout(() => this.queuCounterUpdate(), 10 * 1000);
            this.queuCounterTimer.unref();
        };

        // probably should find a better way than enumerating all cache keys
        let blacklisted = 0;
        Array.from(this.cache.data.keys()).forEach(key => {
            if (/^blacklist:/.test(key)) {
                blacklisted += 1;
            }
        });
        blacklistedGauge.set(blacklisted);

        let date = new Date();
        this.mongodb
            .collection(this.options.collection)
            .find({
                queued: {
                    $lte: date
                }
            })
            .count((err, queued) => {
                if (err) {
                    log.error('Queue', 'Error fetching counters: %s', err.message);
                    return next();
                }
                this.mongodb
                    .collection(this.options.collection)
                    .find({
                        queued: {
                            $gt: date
                        }
                    })
                    .count((err, deferred) => {
                        if (err) {
                            log.error('Queue', 'Error fetching counters: %s', err.message);
                            return next();
                        }

                        queueSizeGauge.set(
                            {
                                type: 'queued'
                            },
                            queued
                        );

                        queueSizeGauge.set(
                            {
                                type: 'deferred'
                            },
                            deferred
                        );

                        return next();
                    });
            });
    }

    /**
     * Starts periodic tasks
     */
    startPeriodicCheck() {
        this.stopPeriodicCheck();

        if (!this.options.disableGC) {
            this.garbageTimer = setTimeout(() => this.checkGarbage(), 10 * 1000);
            this.garbageTimer.unref();
        }

        this.queuCounterTimer = setTimeout(() => this.queuCounterUpdate(), 10 * 1000);
        this.queuCounterTimer.unref();
    }

    /**
     * Stops periodic tasks
     */
    stopPeriodicCheck() {
        clearTimeout(this.garbageTimer);
        this.garbageTimer = null;
    }

    listQueued(zone, type, maxItems, callback) {
        let query = {
            sendingZone: zone,
            queued: {
                [type === 'deferred' ? '$gt' : '$lte']: new Date()
            }
        };

        this.mongodb
            .collection(this.options.collection)
            .find(query)
            .project({
                id: 1,
                sendingZone: 1,
                recipient: 1
            })
            .sort({
                _id: 1
            })
            .limit(maxItems)
            .toArray((err, entries) => {
                if (err) {
                    return callback(err);
                }

                if (!entries || !entries.length) {
                    return callback(null, []);
                }

                return callback(
                    null,
                    entries.map(entry => ({
                        id: entry.id,
                        zone: entry.sendingZone,
                        recipient: entry.recipient
                    }))
                );
            });
    }

    count(zones, type, callback) {
        zones = [].concat(zones || []);

        let result = {
            entries: [],
            rows: 0
        };

        if (!zones || !zones.length) {
            return callback(null, result);
        }

        let checkZone = (zone, type) =>
            new Promise((resolve, reject) => {
                let query = {
                    sendingZone: zone,
                    queued: {
                        [type === 'deferred' ? '$gt' : '$lte']: new Date()
                    }
                };

                this.mongodb
                    .collection(this.options.collection)
                    .find(query)
                    .count((err, count) => {
                        if (err) {
                            return reject(err);
                        }

                        resolve({
                            key: zone,
                            value: count
                        });
                    });
            });

        Promise.all(zones.map(zone => checkZone(zone, type)))
            .then(entries => {
                entries.forEach(entry => {
                    result.entries.push(entry);
                    result.rows += entry.value;
                });
                callback(null, result);
            })
            .catch(err => callback(err));
    }

    /**
     * Stops all timers and closes database
     *
     */
    stop() {
        this.closing = true;
        if (db.mongoclient) {
            db.mongoclient.close(() => false);
        }
        this.stopPeriodicCheck();
    }

    /**
     * Start periodic tasks (garbage colletion and retrieveing deferred elements)
     *
     * @param {Function} callback Run once everything is started
     */
    init(callback) {
        let opts = {};
        Object.keys(this.options[this.options.backend] || {}).forEach(key => {
            opts[key] = this.options[this.options.backend][key];
        });

        db.connect(err => {
            if (err) {
                log.error('Queue', 'Could not initialize MongoDB: %s', err.message);
                return process.exit(1);
            }

            this.mongodb = db.senderDb;
            this.gridstore = new GridFSBucket(this.mongodb, {
                bucketName: this.options.gfs
            });

            let indexes = setupIndexes.indexes;
            let indexpos = 0;
            let ensureIndexes = next => {
                if (indexpos >= indexes.length) {
                    log.info('mongo', 'Setup %s indexes', indexes.length);
                    return next();
                }
                let index = indexes[indexpos++];
                let collection = index.collection;

                if (index.key) {
                    collection = this.options[index.key] + (collection ? '.' + collection : '');
                }

                this.mongodb.collection(collection).createIndexes([index.index], (err, r) => {
                    if (err) {
                        log.error('mongo', 'Failed creating index %s %s. %s', indexpos, JSON.stringify(collection + '.' + index.index.name), err.message);
                    } else if (r.numIndexesAfter !== r.numIndexesBefore) {
                        log.verbose('mongo', 'Created index %s %s', indexpos, JSON.stringify(collection + '.' + index.index.name));
                    } else {
                        log.verbose(
                            'mongo',
                            'Skipped index %s %s: %s',
                            indexpos,
                            JSON.stringify(collection + '.' + index.index.name),
                            r.note || 'No index added'
                        );
                    }

                    ensureIndexes(next);
                });
            };

            // setup indexes if needed
            ensureIndexes(() => {
                // release old locks
                this.mongodb.collection(this.options.collection).updateMany(
                    {
                        locked: true,
                        // only touch messages assigned to this instance
                        assigned: this.instanceId
                    },
                    {
                        $set: {
                            locked: false,
                            lockTime: 0
                        }
                    },
                    {
                        w: 1,
                        multi: true
                    },
                    (err, r) => {
                        if (err) {
                            return callback(err);
                        }

                        if (r.result.n) {
                            log.verbose('GC', 'Released %s expired locks for queued messages', r.result.n);
                        }

                        this.startPeriodicCheck();
                        return setImmediate(() => callback(null, true));
                    }
                );
            });
        });
    }

    generateId(callback) {
        setImmediate(() => callback(null, this.seqIndex.get()));
    }
}

// Expose to the world
module.exports = MailQueue;
