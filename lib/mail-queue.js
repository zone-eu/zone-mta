'use strict';

const log = require('npmlog');
const sendingZone = require('./sending-zone');
const EventEmitter = require('events');
const SeqIndex = require('@zone-eu/seq-index');
const QueueLocker = require('./queue-locker');
const TtlCache = require('./ttl-cache');
const crypto = require('crypto');
const plugins = require('./plugins');
const Headers = require('@zone-eu/mailsplit').Headers;
const db = require('./db');
const GridFSBucket = require('mongodb').GridFSBucket;
const ObjectId = require('mongodb').ObjectId;
const internalCounters = require('./counters');
const bounces = require('./bounces');
const MailDrop = require('./mail-drop');
const yaml = require('js-yaml');
const fs = require('fs');
const pathlib = require('path');
const setupIndexes = yaml.load(fs.readFileSync(pathlib.join(__dirname, '..', 'indexes.yaml'), 'utf8'));
const { gelfCode, emitGelf } = require('./log-gelf');
const gridfsPending = require('./gridfs-pending');

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
        this.maildrop = new MailDrop(this);

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
            gridfsPending.stopPending(store.id);

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
        this.markPending(store.id, 'writing', err => {
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
     * Records that an upload or a delete is in flight for a GridFS file
     *
     * @param {ObjectId} filesId Identifier of the GridFS file
     * @param {String} state Either 'writing' or 'deleting'
     * @param {Function} callback
     */
    markPending(filesId, state, callback) {
        gridfsPending.markPending(this.mongodb, this.options.gfs, filesId, state, callback);
    }

    /**
     * Removes the marker for a completed upload or delete
     *
     * @param {ObjectId} filesId Identifier of the GridFS file
     * @param {Function} callback
     */
    clearPending(filesId, callback) {
        gridfsPending.clearPending(this.mongodb, this.options.gfs, filesId, callback);
    }

    /**
     * Set metadata for a message
     *
     * @param {String} id The ID of the stored data
     * @param {Object} data Data to store as metadata for the stream
     * @param {Function} callback
     */
    setMeta(id, data, callback) {
        this.mongodb.collection(this.options.gfs + '.files').updateOne(
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
                    writeConcern: 1,
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
                deliveryZone = this.options.defaultZone || 'default';
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

                const mxData = routing.mxData || {};

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
                    created: date,

                    // add sessionId
                    sessionId: envelope.sessionId
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

                // Outbound relay specified
                ['mx', 'mxPort', 'mxAuth', 'mxSecure'].forEach(key => {
                    if (mxData[key]) {
                        delivery[key] = mxData[key];
                    }
                });

                if (mxData.skipSRS) {
                    delivery.skipSRS = true;
                }

                if (mxData.skipSTS) {
                    delivery.skipSTS = true;
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

        zone = zone || this.options.defaultZone || 'default';
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
                    if (this.options.logQueuePolling) {
                        plugins.handler.remotelog(
                            (item && item.value && item.value.id) || null,
                            (item && item.value && item.value.seq) || false,
                            'QUEUE_POLL',
                            {
                                query,
                                match: item && item.value ? true : false,
                                error: err && err.message
                            }
                        );
                    }

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
                            if (key !== 'sendingZone') {
                                delivery[key] = meta[key];
                            }
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
                                        domain: delivery.domain.toLowerCase().trim()
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

        // every delete operation gets an unique ID, so if we fail, we can release locked deliveries
        let deleteId = 'delete:' + crypto.randomBytes(10).toString('base64');

        let collection = this.mongodb.collection(this.options.collection);
        let cursor = collection.find(query, {
            projection: {
                _id: true,
                id: true,
                seq: true
            }
        });

        let releaseNext = () => {
            cursor.next((err, delivery) => {
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
                        emitGelf({
                            short_message: `${gelfCode('QUEUE_DELETE_FAILED')} Failed to delete delivery`,
                            _stack: err && err.stack ? err.stack : undefined,
                            _logger: 'Delete',
                            _delivery_id: delivery.id,
                            _delivery_seq: delivery.seq,
                            _zone: delivery.zoneName,
                            _failure_msg: err.message
                        });
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
                writeConcern: 1,
                multi: true
            },
            (err, r) => {
                if (err) {
                    return callback(err);
                }

                return callback(null, r.modifiedCount);
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
                        projection: {
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
                        log.info(`Sender/${delivery.sendingZone}/${process.pid} All SMTP sessions end id=${delivery.sessionId}`);
                        this.removeMessage(delivery.id, err => callback(null, !err));
                    }
                );
            }
        );
    }

    releaseDeliveryAsync(delivery) {
        return new Promise((resolve, reject) => {
            this.releaseDelivery(delivery, (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * Method that marks a message as deferred. This message is removed from the active queued
     *
     * @param {Object} delivery Message object
     * @param {Number} ttl TTL in ms. Once this time is over the message is reinserted to queue
     * @param {Object} responseData SMTP response or description
     * @param {Function} callback Run once the message is removed from active queue
     */
    deferDelivery(delivery, ttl, responseData, callback) {
        // add metainfo about postponing the delivery

        const now = Date.now();

        let updates = {
            $set: {
                '_deferred.last': now,
                '_deferred.next': now + ttl,
                queued: new Date(now + ttl),
                locked: false
            },
            $inc: {
                '_deferred.count': 1
            }
        };

        if (!delivery._deferred) {
            updates.$set['_deferred.first'] = now;
        }

        if (responseData.response) {
            updates.$set['_deferred.response'] = responseData.response;
        }

        if (responseData.log) {
            updates.$set['_deferred.log'] = responseData.log;
        }

        if (responseData.updates && typeof responseData.updates === 'object') {
            Object.keys(responseData.updates).forEach(key => {
                if (key.charAt(0) === '$') {
                    if (!['$inc', '$mul'].includes(key)) {
                        return; // not allowed
                    }
                    // $inc etc.
                    updates[key] = Object.assign(updates[key] || {}, responseData.updates[key]);
                    return;
                }
                if (!updates.$set.hasOwnProperty(key)) {
                    updates.$set[key] = responseData.updates[key];
                }
            });
        }

        let collection = this.mongodb.collection(this.options.collection);
        collection.findOneAndUpdate(
            {
                id: delivery.id,
                seq: delivery.seq
            },
            updates,
            {
                returnOriginal: true
            },
            (err, item) => {
                if (err) {
                    return callback(err);
                }

                // safe to remove the lock
                log.verbose('Queue', '%s.%s UNLOCK (key="%s")', delivery.id, delivery.seq, delivery._lock);
                this.locks.release(delivery._lock);

                if (item && item.value) {
                    let firstCheck = item.value._deferred && item.value._deferred.first;
                    let prevLastCheck = item.value._deferred && item.value._deferred.last;
                    let lastCheck = now;

                    if (firstCheck && prevLastCheck) {
                        return this.getMeta(delivery.id, (err, meta) => {
                            if (err) {
                                // ignore
                                log.error('Queue', '%s.%s GET META %s', delivery.id, delivery.seq, err.message);
                                emitGelf({
                                    short_message: `${gelfCode('QUEUE_META_FETCH_FAILED')} Failed to fetch delivery metadata`,
                                    _stack: err && err.stack ? err.stack : undefined,
                                    _logger: 'Queue',
                                    _delivery_id: delivery.id,
                                    _delivery_seq: delivery.seq,
                                    _failure_msg: err.message
                                });
                                return callback(null, true);
                            }

                            let deliveryEntry = Object.assign(item.value, meta || {});
                            deliveryEntry.headers = new Headers(deliveryEntry.headers);

                            deliveryEntry.envelope = {
                                from: deliveryEntry.from,
                                to: deliveryEntry.recipient
                            };

                            if (!bounces.canSendBounce(deliveryEntry, { logName: 'Queue' })) {
                                return callback(null, true);
                            }

                            return plugins.handler.runHooks(
                                'queue:delayed',
                                [
                                    Object.assign({}, deliveryEntry, responseData),
                                    this.maildrop,
                                    {
                                        first: firstCheck,
                                        prev: prevLastCheck,
                                        last: lastCheck
                                    }
                                ],
                                err => {
                                    if (err) {
                                        log.error('Queue', '%s.%s queue:delayed %s', deliveryEntry.id, deliveryEntry.seq, err.message);
                                        emitGelf({
                                            short_message: `${gelfCode('QUEUE_DELAYED_HOOK_FAILED')} queue:delayed hook failed`,
                                            _stack: err && err.stack ? err.stack : undefined,
                                            _logger: 'Queue',
                                            _delivery_id: deliveryEntry.id,
                                            _delivery_seq: deliveryEntry.seq,
                                            _failure_msg: err.message
                                        });
                                    }

                                    return callback(null, true);
                                }
                            );
                        });
                    }
                }

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
                this.removeGridfsFile(entry._id, callback);
            }
        );
    }

    /**
     * Deletes a GridFS file in an order that leaves an interruption recoverable
     *
     * GridFSBucket.delete() removes the files document first and the chunks second, with no
     * transaction around the pair, so a process that dies in between leaves chunks that nothing
     * names: files_id is their only link and it is recorded nowhere else. Marking first, then
     * deleting chunks before the files document, means every interruption leaves either a
     * marker or a complete file, and the GC can tell which.
     *
     * @param {ObjectId} filesId Identifier of the GridFS file
     * @param {Function} callback
     */
    removeGridfsFile(filesId, callback) {
        this.markPending(filesId, 'deleting', err => {
            if (err) {
                return callback(err);
            }
            this.mongodb.collection(this.options.gfs + '.chunks').deleteMany({ files_id: filesId }, err => {
                if (err) {
                    return callback(err);
                }
                this.mongodb.collection(this.options.gfs + '.files').deleteOne({ _id: filesId }, err => {
                    if (err) {
                        return callback(err);
                    }
                    this.clearPending(filesId, pendingErr => {
                        if (pendingErr) {
                            // The file is gone; only the marker removal failed. The GC sees a
                            // 'deleting' marker with no files document and drops it.
                            log.info('Queue', 'Failed to clear the delete marker for %s. %s', filesId, pendingErr.message);
                        }
                        callback(null, true);
                    });
                });
            });
        });
    }

    async clearGarbage() {
        let collection = this.mongodb.collection(this.options.collection);
        let r;

        // Clear message locks
        r = await collection.updateMany(
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
                writeConcern: 1,
                multi: true
            }
        );

        if (r && r.modifiedCount) {
            log.verbose('GC', 'Released %s expired locks for queued messages', r.modifiedCount);
        }

        // Finish uploads and deletes that were interrupted. This runs ahead of the disableGC
        // check on purpose: it does not remove anything by age, it completes operations that
        // were already started, and an interrupted one is not something an installation can
        // choose to keep. Gating it would also let the marker collection grow without bound on
        // a process that never collects.
        await this.collectPendingGridfs();

        if (this.options.disableGC) {
            return;
        }

        if (this.options.maxQueueTime && this.options.maxQueueTime > 0) {
            // Release messages queued longer than allowed
            let releaseObjectId = ObjectId.createFromTime(Math.round((Date.now() - this.options.maxQueueTime) / 1000));
            let cursor = await collection.find(
                {
                    _id: {
                        $lte: releaseObjectId
                    },
                    // skip messages that are currently being processed
                    locked: false
                },
                {
                    projection: {
                        _id: 1,
                        id: true,
                        seq: true,
                        _lock: true
                    }
                }
            );

            let delivery;
            while ((delivery = await cursor.next())) {
                try {
                    let deleted = await this.releaseDeliveryAsync(delivery);
                    if (deleted) {
                        log.info('GC', 'Cleaned up %s from queue', delivery.id);
                    }
                } catch (err) {
                    log.info('GC', 'Failed to cleaned up %s.%s from queue. %s', delivery.id, delivery.seq, err.message);
                }
            }
            await cursor.close();
        }


        // The coarse half, kept as a backstop for what the markers cannot know about: anything
        // orphaned before this mechanism existed, and the chunks it strands itself on the rare
        // message whose upload straddles the water mark, which a later pass then picks up. It
        // collects by age rather than by reachability, so it is late, up to maxQueueTime late
        // while a deferring delivery holds the mark back, but it needs no knowledge of how the
        // state came about.
        //
        // Both deletes below are _id range scans on an always-indexed field, and the mark sits
        // below the oldest queued message, so nothing a live message owns is ever in range.

        // Find the oldest queued message
        let delivery = await collection.findOne(
            {},
            {
                sort: { _id: 1 },
                projection: {
                    _id: 1
                }
            }
        );

        let clearUntil;
        if (delivery) {
            clearUntil = delivery._id.getTimestamp().getTime();
        } else {
            // empty queue, so delete everything
            clearUntil = Date.now();
        }

        // 10 minute shift just in case
        clearUntil -= 10 * 60 * 1000;

        let untilObjectId = ObjectId.createFromTime(Math.round(new Date(clearUntil).getTime() / 1000));
        let query = {
            _id: {
                $lte: untilObjectId
            }
        };

        r = await this.mongodb.collection(this.options.gfs + '.files').deleteMany(query);
        if (r && r.deletedCount) {
            log.info('GC', 'Cleared %s expired files from GridStore', r.deletedCount);
        }

        r = await this.mongodb.collection(this.options.gfs + '.chunks').deleteMany(query);
        if (r && r.deletedCount) {
            log.info('GC', 'Cleared %s expired chunks from GridStore', r.deletedCount);
        }
    }

    /**
     * Finishes GridFS uploads and deletes that an interrupted process left half done
     *
     * Reads the markers rather than the chunks, so in the steady state this reads an empty
     * collection. Each marker carries its own deadline, written by the process that opened the
     * operation, so this only has to compare it against the clock - there is nothing here to
     * derive, and no way for a sweeping process to disagree with a writing one about how long an
     * operation was allowed to take.
     *
     * The state on the marker is what makes the two halves distinguishable. A file with no
     * chunks means opposite things depending on which operation was in flight, and a collector
     * that deleted on sight would destroy a message that had been queued successfully.
     */
    async collectPendingGridfs() {
        let deliveries = this.mongodb.collection(this.options.collection);
        let files = this.mongodb.collection(this.options.gfs + '.files');
        let chunks = this.mongodb.collection(this.options.gfs + '.chunks');
        let pending = this.mongodb.collection(this.options.gfs + '.pending');

        let cursor = pending.find({ expires: { $lte: new Date() } });
        let repaired = 0;

        try {
            while (await cursor.hasNext()) {
                let marker = await cursor.next();

                // Per marker, so one transient Mongo failure costs that marker a pass rather
                // than every marker behind it. A failure here also leaves the marker in place,
                // because its removal is the last step inside the try, so the work is retried
                // rather than forgotten.
                try {
                    let exists = await files.findOne({ _id: marker._id }, { projection: { _id: 1, filename: 1 } });

                    if (marker.state === 'deleting' && exists) {
                        // The delete stopped partway. Finish it in the order it would have run in.
                        await chunks.deleteMany({ files_id: marker._id });
                        await files.deleteOne({ _id: marker._id });
                        repaired++;
                    } else if (marker.state !== 'deleting' && !exists) {
                        // An upload that never produced a files document, so its chunks are
                        // unreachable.
                        await chunks.deleteMany({ files_id: marker._id });
                        repaired++;
                    } else if (marker.state !== 'deleting' && exists && !(await isQueued(deliveries, exists.filename))) {
                        // The upload finished but the message never reached the queue, so nothing
                        // will ever deliver or delete it. The marker is only cleared once a
                        // delivery exists, so a marker this old with no delivery behind it means
                        // the process died in between - the one case where a complete file is
                        // still nobody's.
                        await chunks.deleteMany({ files_id: marker._id });
                        await files.deleteOne({ _id: marker._id });
                        repaired++;
                    }

                    // Anything else is a marker whose own removal was lost: the message is queued,
                    // or the delete all but finished. Dropping the marker is the whole of the
                    // repair, and deleting the file in the first of those cases would destroy a
                    // queued message.
                    await pending.deleteOne({ _id: marker._id });
                } catch (err) {
                    log.info('GC', 'Failed to finish interrupted GridFS operation %s. %s', marker._id, err.message);
                }
            }
        } finally {
            // A delete failing mid-loop must not leave the cursor open on the server, and a
            // close that fails must not replace the error that got us here.
            try {
                await cursor.close();
            } catch (err) {
                log.info('GC', 'Failed to close the pending cursor. %s', err.message);
            }
        }

        if (repaired) {
            log.info('GC', 'Finished %s interrupted GridFS operation(s)', repaired);
        }
    }

    /**
     * Method that perdiodically checks and removes garbage
     */
    checkGarbage() {
        clearTimeout(this.garbageTimer);
        let startTimer = Date.now();
        this.clearGarbage()
            .then(() => {
                this.garbageTimer = setTimeout(() => this.checkGarbage(), 60 * 1000);
                this.garbageTimer.unref();
            })
            .catch(err => {
                let timeDiff = (Date.now() - startTimer) / 1000;
                log.error('GC', '[%ss] %s', timeDiff, err.message);
                emitGelf({
                    short_message: `${gelfCode('QUEUE_GC_FAILED')} Garbage collection failed`,
                    _stack: err && err.stack ? err.stack : undefined,
                    _logger: 'GC',
                    _duration_s: timeDiff,
                    _failure_msg: err.message
                });
                this.garbageTimer = setTimeout(() => this.checkGarbage(), 5 * 60 * 1000);
                this.garbageTimer.unref();
            });
    }

    queueCounterUpdate() {
        clearTimeout(this.queueCounterTimer);

        let next = () => {
            this.queueCounterTimer = setTimeout(() => this.queueCounterUpdate(), 10 * 1000);
            this.queueCounterTimer.unref();
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
        this.mongodb.collection(this.options.collection).countDocuments(
            {
                queued: {
                    $lte: date
                }
            },
            (err, queued) => {
                if (err) {
                    log.error('Queue', 'Error fetching counters: %s', err.message);
                    emitGelf({
                        short_message: `${gelfCode('QUEUE_COUNTERS_FAILED')} Failed to fetch queue counters`,
                        _stack: err && err.stack ? err.stack : undefined,
                        _logger: 'Queue',
                        _failure_msg: err.message
                    });
                    return next();
                }

                this.mongodb.collection(this.options.collection).countDocuments(
                    {
                        queued: {
                            $gt: date
                        }
                    },
                    (err, deferred) => {
                        if (err) {
                            log.error('Queue', 'Error fetching counters: %s', err.message);
                            emitGelf({
                                short_message: `${gelfCode('QUEUE_COUNTERS_FAILED')} Failed to fetch queue counters`,
                                _stack: err && err.stack ? err.stack : undefined,
                                _logger: 'Queue',
                                _failure_msg: err.message
                            });
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
                    }
                );
            }
        );
    }

    /**
     * Starts periodic tasks
     */
    startPeriodicCheck() {
        this.stopPeriodicCheck();

        this.garbageTimer = setTimeout(() => this.checkGarbage(), 60 * 1000);
        this.garbageTimer.unref();

        this.queueCounterTimer = setTimeout(() => this.queueCounterUpdate(), 10 * 1000);
        this.queueCounterTimer.unref();
    }

    /**
     * Stops periodic tasks
     */
    stopPeriodicCheck() {
        clearTimeout(this.garbageTimer);
        this.garbageTimer = null;
    }

    listQueued(zone, type, sort, start, maxItems, callback) {
        sort = sort || {
            _id: 1
        };

        start = start || 0;

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
                recipient: 1,
                queued: 1,
                created: 1,
                '_deferred.count': 1
            })
            .sort(sort)
            .skip(start)
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
                        recipient: entry.recipient,
                        created: entry.created.toISOString(),
                        queued: entry.queued.toISOString(),
                        deferred: (entry._deferred && entry._deferred.count) || 0
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

                this.mongodb.collection(this.options.collection).countDocuments(query, (err, count) => {
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
     * Start periodic tasks (garbage collection and retrieveing deferred elements)
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
                log.error('Queue', 'Could not initialize database: %s', err.message);
                emitGelf({
                    short_message: `${gelfCode('QUEUE_DB_INIT_FAILED')} Could not initialize queue database`,
                    full_message: err && err.stack ? err.stack : undefined,
                    _logger: 'Queue',
                    _error: err.message
                });
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
                        emitGelf({
                            short_message: `${gelfCode('QUEUE_INDEX_CREATE_FAILED')} Failed to create MongoDB index`,
                            _stack: err && err.stack ? err.stack : undefined,
                            _logger: 'mongo',
                            _index_pos: indexpos,
                            _collection: collection,
                            _index_name: index.index && index.index.name,
                            _failure_msg: err.message
                        });
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
                        writeConcern: 1,
                        multi: true
                    },
                    (err, r) => {
                        if (err) {
                            return callback(err);
                        }

                        if (r.modifiedCount) {
                            log.verbose('GC', 'Released %s expired locks for queued messages', r.modifiedCount);
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

// Whether any delivery still references a stored message. GridFS names the file `message <id>`
// and the queue keys on that id, which is the only link between the two.
async function isQueued(collection, filename) {
    let id = typeof filename === 'string' && filename.indexOf('message ') === 0 ? filename.slice('message '.length) : null;
    if (!id) {
        // A file this collector cannot name is left alone rather than guessed at. Nothing names
        // one this way today, so a line here means the convention has drifted.
        log.info('GC', 'Cannot map %s to a message id, leaving the file alone', filename);
        return true;
    }
    let delivery = await collection.findOne({ id }, { projection: { _id: 1 } });
    return !!delivery;
}

// Expose to the world
module.exports = MailQueue;
