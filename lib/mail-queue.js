'use strict';

const levelup = require('levelup');
const levelStreamAccess = require('level-stream-access');
const log = require('npmlog');
const sendingZone = require('./sending-zone');
const EventEmitter = require('events');
const SeqIndex = require('seq-index');
const mkdirp = require('mkdirp');
const SharedIterator = require('./shared-iterator');
const QueueLocker = require('./queue-locker');
const TtlCache = require('./ttl-cache');

/**
 * MailQueue class for generating mail queue instances. These instances handle
 * storing and retrieving emails and delivery data from a leveldb database
 */
class MailQueue {

    /**
     * Initializes a new MailQueue object
     *
     * @constructor
     * @param {Object} options Instance options
     * @param {Object/String} db Either a levelup instance or a path to leveldb location
     */
    constructor(options) {
        this.options = options || {};
        this.db = options.dbinstance || false;
        this.closing = false;
        this.streamer = false;
        this.seqCounter = Date.now();
        this.deferTimer = null;
        this.garbageTimer = null;
        this.seqIndex = new SeqIndex();

        this.cache = new TtlCache(); // shared cache for workers
        this.iterators = new Map();

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
        let store = this.streamer.createWriteStream('message ' + id);

        stream.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
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
        this.streamer.setMeta('message ' + id, data, callback);
    }

    /**
     * Get metadata for a message
     *
     * @param {String} id The ID of the stored data
     * @param {Function} callback Returns the stored metadata as an object
     */
    getMeta(id, callback) {
        this.streamer.getMeta('message ' + id, callback);
    }

    /**
     * Creates a read stream from the backend storage
     *
     * @param  {String} id Id of the stored data
     * @return {Stream} Stream
     */
    retrieve(id) {
        return this.streamer.createReadStream('message ' + id);
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
        let ops = [];

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
            this.db.batch(ops, err => {
                if (err) {
                    return callback(err);
                }

                callback(null, id);
            });
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
            let recipientDomain = recipient.substr(recipient.lastIndexOf('@') + 1).replace(/[\[\]]/g, '');
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

            seq++;
            let deliverySeq = (seq < 0x100 ? '0' : '') + (seq < 0x10 ? '0' : '') + seq.toString(16);
            let delivery = {
                id,
                seq: deliverySeq,

                // Store indexing keys in the delivery object
                // sort by Zone
                _zoneKey: 'delivery-zone ' + encodeURIComponent(deliveryZone) + ' ' + id + ' ' + encodeURIComponent(recipient),
                // sort by Domain
                _domainKey: 'delivery-domain ' + encodeURIComponent(recipientDomain) + ' ' + encodeURIComponent(deliveryZone) + ' ' + id + ' ' + encodeURIComponent(recipient),
                // reference for ID
                _refKey: 'ref ' + id + ' ' + encodeURIComponent(deliveryZone) + ' ' + encodeURIComponent(recipient),
                // reference for ID + SEQ
                _seqKey: 'seq ' + id + ' ' + deliverySeq,

                // Actual delivery data
                domain: recipientDomain,
                sendingZone: deliveryZone,

                // actual recipient address
                recipient
            };

            if (!envelope.deferDelivery) {
                // Normal insert

                // List all remaining deliveries for a zone sorted by message id
                // Needed to find deliveries by Zone
                ops.push({
                    type: 'put',
                    key: delivery._zoneKey,
                    value: delivery._refKey
                });

                // List all remaining deliveries for a zone sorted by domain and message id
                // Needed to find deliveries by Zone + domain
                ops.push({
                    type: 'put',
                    key: delivery._domainKey,
                    value: delivery._refKey
                });
            } else {
                // Deferred insert

                // Setup defer data
                delivery._deferred = delivery._deferred || {
                    first: Date.now(),
                    count: 0
                };
                delivery._deferred.last = Date.now();
                delivery._deferred.next = envelope.deferDelivery;
                delivery._deferred.response = 'Deferred by router';

                // Add to defer queue
                ops.push({
                    type: 'put',
                    key: 'deferred:item ' + delivery._deferred.next + ' ' + this.seqIndex.short(),
                    value: [delivery._zoneKey, delivery._domainKey, delivery._refKey].join('\n')
                });

                // Mark key as deferred
                // Useful for finding deferred messages for a zone
                ops.push({
                    type: 'put',
                    key: 'deferred:key ' + delivery._zoneKey,
                    value: 1
                });

                // Mark domain key as deferred
                // Useful for finding deferred messages for a zone+domain
                ops.push({
                    type: 'put',
                    key: 'deferred:domain ' + delivery._domainKey,
                    value: 1
                });

            }

            // Keep references against a message id. Once there are no more references
            // against a message ID, the message can be safely deleted. This is also the
            // key we use to store the delivery data
            ops.push({
                type: 'put',
                key: delivery._refKey,
                value: delivery,
                valueEncoding: 'json'
            });

            // List all remaining deliveries for ID+SEQ
            // Needed to find deliveries by ID+SEQ
            ops.push({
                type: 'put',
                key: delivery._seqKey,
                value: delivery._refKey
            });

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

        let index, end;
        let lockOwner = options.lockOwner || false;
        let getDomainConfig = options.getDomainConfig;
        let iteratorName = 'zone ' + zone;

        // index by zone
        index = 'delivery-zone ' + encodeURIComponent(zone) + ' ';
        end = 'delivery-zone ' + encodeURIComponent(zone) + ' ~';

        let iterator = this.getSharedIterator(iteratorName, {
            gt: index,
            lt: end,
            keys: true,
            values: false,
            fillCache: true,
            keyAsBuffer: false,
            valueAsBuffer: false,
            limit: 100 * 1000
        });

        // iterate over all keys to find first matching and unlocked delivery
        let tryNext = () => {
            iterator.next((err, key) => {
                if (err) {
                    return callback(err);
                }
                if (this.closing) {
                    return callback(null, false);
                }
                if (!key) {
                    // We only end up here if we scanned through all keys and found nothing
                    return callback(null, false);
                }

                // all indexing keys end with ' [id] [recipient]'
                let keyParts = key.split(' ');
                let recipient = decodeURIComponent(keyParts.pop());
                let deliveryDomain = recipient.substr(recipient.lastIndexOf('@') + 1); // domains in keys are already normalized
                let id = keyParts.pop();
                let lockKey = 'message ' + id + ' ' + encodeURIComponent(recipient);

                let maxConnections = Number(typeof getDomainConfig === 'function' && getDomainConfig(deliveryDomain).maxConnections) || 0;

                let zoneKey = key;

                // Check if the key is already locked
                // Lock TTL is relatively high, this is because if the MX has several IP addresses and
                // all of them refuse to accept connections then connecting to all possible IPs might take time
                let lockTtl = 60 * 60 * 1000;
                if (!this.locks.lock(lockKey, zone, deliveryDomain, lockOwner, maxConnections, lockTtl)) {
                    // nothing to do here, already locked by someone else
                    return setImmediate(tryNext);
                }

                // Instead of loading key value from iterator, we only fetch the key and then
                // load value separately. This protects us against out-of-date iterators.
                // Iterators use a snapshot of the data which might be out of date by the
                // time we use it
                this.db.get(key, (err, value) => {
                    if (err) {
                        if (err.name === 'NotFoundError') {
                            // out of date iterator, we received a key but it was already removed
                            this.locks.release(lockKey);
                            return setImmediate(tryNext);
                        }
                        return callback(err);
                    }

                    let refKey = value;

                    // now try to fetch contents for the delivery using the ref key value we got from queue key
                    // actual value key is stored as the value of the indexing key ('ref …')
                    this.db.get(refKey, {
                        valueEncoding: 'json'
                    }, (err, delivery) => {
                        if (err) {
                            if (err.name === 'NotFoundError') {
                                // this situation might happen if we recovered a deferred delivery that was already processed
                                // or there was a race condition where we started an iterator just before a key was deleted

                                this.db.get(zoneKey, err => {
                                    if (err && err.name === 'NotFoundError') {
                                        this.locks.release(lockKey);
                                        // zone key was not found, so this must be an iterator race, just ignore it
                                        return setImmediate(tryNext);
                                    }

                                    let domainKey = zoneKey.replace(/^delivery\-zone /, 'delivery-domain ' + key.split('%40').pop() + ' ');

                                    // zone key was found. probably a deferred recovery race, delete all
                                    return this.releaseDelivery({
                                        _zoneKey: zoneKey,
                                        _domainKey: domainKey,
                                        _refKey: refKey,
                                        _lock: lockKey
                                    }, err => {
                                        if (err) {
                                            return callback(err);
                                        }
                                        setImmediate(tryNext);
                                    });
                                });
                                return;
                            }
                            return callback(err);
                        }
                        // Store used lock key in the delivery object
                        delivery._lock = lockKey;

                        log.verbose('Queue', '%s.%s SHIFTED (key="%s" iterator="%s")', delivery.id, delivery.seq, lockKey, iteratorName);

                        callback(null, delivery);
                    });
                });
            });
        };

        tryNext();
    }

    /**
     * Retrieves a delivery by message ID and sequence number
     *
     * @param {String/Number} id Message ID
     * @param {String} seq Sequence number (0-padded hex, at least 3 symbols)
     * @param {Function} callback Returns the delivery object
     */
    getDelivery(id, seq, callback) {
        this.db.get('seq ' + id + ' ' + seq, (err, refKey) => {
            if (err) {
                if (err.name === 'NotFoundError') {
                    return callback(null, false);
                }
                return callback(err);
            }
            if (!refKey) {
                return callback(null, false);
            }
            this.db.get(refKey, {
                valueEncoding: 'json'
            }, (err, delivery) => {
                if (err) {
                    if (err.name === 'NotFoundError') {
                        return callback(null, false);
                    }
                    return callback(err);
                }
                callback(null, delivery);
            });
        });
    }

    /**
     * General helper to fetch a range of values as an Array
     *
     * @param {Object} query LevelUp query
     * @param {Function} callback Function for the result array
     */
    get(query, callback) {
        let returned = false;
        let response = [];

        let stream = this.db.createReadStream(query);

        stream.on('data', data => {
            if (returned) {
                return;
            }
            if (this.closing) {
                returned = true;
                stream.destroy();
                return callback(new Error('Server shutdown in progress'));
            }
            response.push(data);
        }).once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        }).on('end', () => {
            if (returned) {
                return;
            }
            returned = true;
            callback(null, response);
        });
    }

    /**
     * Wrapper around this.get to returns the first key in a range
     *
     * @param {Object} query LevelUp query
     * @param {Function} callback Function for the result key
     */
    getFirst(query, callback) {
        let options = {
            keys: true,
            values: false,
            limit: 1
        };

        Object.keys(query || {}).forEach(key => {
            options[key] = query[key];
        });

        this.get(options, (err, result) => {
            if (err) {
                return callback(err);
            }
            return callback(null, result && result.length ? result[0] : false);
        });
    }

    /**
     * Deletes keys by range query
     *
     * @param {Object} query LevelUp query
     * @param {Function} callback Function for the result key
     */
    deleteRange(query, callback) {
        let keys = this.db.createKeyStream(query);
        let returned = false;
        let deleted = 0;

        keys.on('readable', () => {
            if (returned) {
                return;
            }
            let key, ops = [];
            while ((key = keys.read()) !== null) {
                ops.push({
                    type: 'del',
                    key
                });
            }
            if (ops.length) {
                deleted += ops.length;
                this.db.batch(ops, err => {
                    if (returned) {
                        return;
                    }
                    if (err) {
                        returned = true;
                        return callback(err);
                    }
                });
            }
        });

        keys.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        });

        keys.on('end', () => {
            if (returned) {
                return;
            }
            returned = true;
            callback(null, deleted);
        });
    }

    /**
     * Removes a delivery from the queue. This happens when a message is delivered or it bounces
     *
     * @param {Object} delivery Message object
     * @param {Function} callback Run once the message is removed from the queue
     */
    releaseDelivery(delivery, callback) {
        let ops = [

            // delete delivery data
            {
                type: 'del',
                key: delivery._zoneKey
            }, {
                type: 'del',
                key: delivery._domainKey
            },

            // delete reference to message source
            {
                type: 'del',
                key: delivery._refKey
            }
        ];

        if (delivery._seqKey) {
            ops.push({
                type: 'del',
                key: delivery._seqKey
            });
        }

        this.db.batch(ops, {
            sync: false
        }, err => {
            // whatever happened, no need to hold the lock anymore
            this.locks.release(delivery._lock);

            if (err) {
                return callback(err);
            }

            // Try to find a delivery reference for the message body. If references
            // are not found then this message body is no longer needed and can be deleted
            this.getFirst({
                gt: 'ref ' + delivery.id + ' ',
                lt: 'ref ' + delivery.id + ' ~'
            }, (err, item) => {
                if (!err && !item) {
                    log.verbose('Queue', 'Deleting unreferenced message %s', delivery.id);
                    // no pending references, safe to remove the stored message
                    this.streamer.delete('message ' + delivery.id, err => callback(null, !err));
                } else {
                    // message still has pending references, so do nothing
                    return callback(null, false);
                }
            });
        });
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
        delivery._deferred.next = (Date.now() + ttl);
        delivery._deferred.response = responseData.response;
        delivery._deferred.log = responseData.log || delivery._deferred.log;

        let ops = [
            // move delivery
            {
                // remove from zone based queue
                type: 'del',
                key: delivery._zoneKey
            }, {
                // remove from zone+domain based queue
                type: 'del',
                key: delivery._domainKey
            }, {
                // update value
                type: 'put',
                key: delivery._refKey,
                value: delivery,
                valueEncoding: 'json'
            }, {
                // add to defer queue
                type: 'put',
                key: 'deferred:item ' + delivery._deferred.next + ' ' + this.seqIndex.short(),
                value: [delivery._zoneKey, delivery._domainKey, delivery._refKey].join('\n')
            }, {
                // mark key as deferred
                // useful for finding deferred messages for a zone
                type: 'put',
                key: 'deferred:key ' + delivery._zoneKey,
                value: 1
            }, {
                // mark domain key as deferred
                // // useful for finding deferred messages for a zone+domain
                type: 'put',
                key: 'deferred:domain ' + delivery._domainKey,
                value: 1
            }
        ];

        this.db.batch(ops, err => {
            if (err) {
                return callback(err);
            }

            // safe to remove the lock
            log.verbose('Queue', '%s.%s UNLOCK (key="%s")', delivery.id, delivery.seq, delivery._lock);
            this.locks.release(delivery._lock);

            return callback(null, true);
        });
    }

    /**
     * Method that recovers deferred messages
     *
     * @param {Function} callback FUnction to run once all deferred messages are recovered
     */
    recoverDeferred(callback) {
        let stream = this.db.createReadStream({
            gt: 'deferred:item ',
            lte: 'deferred:item ' + Date.now() + ' ~'
        });

        let processed = 0;
        let returned = false;

        stream.on('readable', () => {
            if (returned) {
                return;
            }
            if (this.closing) {
                returned = true;
                stream.destroy();
                return callback(new Error('Server shutdown in progress'));
            }
            let data;
            let ops = [];
            while ((data = stream.read()) !== null) {
                let lines = data.value.split('\n');
                let zoneKey = lines.shift();
                let domainKey = lines.shift();
                let refKey = lines.join('\n');
                processed++;

                // recover original delivery item
                ops.push({
                    type: 'put',
                    key: zoneKey,
                    value: refKey
                });
                ops.push({
                    type: 'put',
                    key: domainKey,
                    value: refKey
                });

                // delete ttl placeholders
                ops.push({
                    type: 'del',
                    key: data.key
                });
                ops.push({
                    type: 'del',
                    key: 'deferred:key ' + zoneKey
                });
                ops.push({
                    type: 'del',
                    key: 'deferred:domain ' + domainKey
                });
            }
            this.db.batch(ops);
        });

        stream.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        });

        stream.on('end', () => {
            if (returned) {
                return;
            }
            returned = true;

            callback(null, processed.length ? processed : false);
        });
    }

    /**
     * Method that perdiodically checks and retrieves deferred messages
     */
    checkDeferred() {
        clearTimeout(this.deferTimer);
        this.recoverDeferred((err, processed) => {
            if (err) {
                log.error('Queue', err);
            }
            if (processed) {
                log.verbose('Queue', 'Recovered %s TTLed items', processed);
            }
            let nextCheck = 15 * 1000;
            log.silly('Queue', 'Next TTL recovery check in %s s', nextCheck / 1000);
            this.deferTimer = setTimeout(() => this.checkDeferred(), nextCheck);
            this.deferTimer.unref();
        });
    }

    /**
     * Retrieves info about currently queued deliveries for a queue ID
     */
    getInfo(id, callback) {
        let options = {
            keys: true,
            values: true,
            gt: 'seq ' + id + ' ',
            lt: 'seq ' + id + ' ~'
        };

        this.get(options, (err, result) => {
            if (err) {
                return callback(err);
            }

            if (!result || !result.length) {
                return callback(null, false);
            }

            let messages = [];
            let pos = 0;
            let checkMessage = () => {
                if (pos >= result.length) {
                    this.getMeta(id, (err, meta) => {
                        if (err) {
                            return callback(err);
                        }
                        callback(null, {
                            meta,
                            messages
                        });
                    });
                    return;
                }
                let entry = result[pos++];
                let keyparts = (entry && entry.key || '').split(' ');
                let valparts = (entry && entry.value || '').split(' ');
                let message = {
                    id,
                    seq: keyparts[2],
                    zone: decodeURIComponent(valparts[2]),
                    recipient: decodeURIComponent(valparts[3]),
                    status: 'QUEUED',
                    lock: this.locks.locks.get('message ' + id + ' ' + valparts[3])
                };

                let checkDeferred = done => {
                    this.db.get('deferred:key delivery-zone ' + encodeURIComponent(message.zone) + ' ' + id + ' ' + encodeURIComponent(message.recipient), (err, deferred) => {
                        if (err && err.name !== 'NotFoundError') {
                            return callback(err);
                        }

                        if (deferred) {
                            message.status = 'DEFERRED';
                        }

                        this.db.get(entry.value, {
                            valueEncoding: 'json'
                        }, (err, delivery) => {
                            if (err) {
                                if (err.name === 'NotFoundError') {
                                    return done();
                                }
                                return callback(err);
                            }
                            message.deferred = delivery._deferred;
                            return done();
                        });
                    });
                };

                checkDeferred(() => {
                    messages.push(message);
                    return checkMessage();
                });
            };
            checkMessage();
        });
    }

    /**
     * Removes old messages without checking if there are any references left (there shouldn't be)
     *
     * @param {Function} callback Runs once the keys have been removed
     */
    clearGarbage(callback) {
        // find the oldest undelivered message and delete everything older than it
        this.getFirst({
            gt: 'ref ',
            lt: 'ref ~',
            keys: true,
            values: false
        }, (err, refKey) => {
            if (err) {
                return callback(err);
            }
            let clearUntil;
            if (!refKey) {
                // if message queue is empty delete everything older than 10 minutes
                clearUntil = Date.now();
            } else {
                let keyParts = refKey.split(' ');
                keyParts.shift();
                clearUntil = Math.round(parseInt(keyParts.shift().substr(0, 14), 16) / 0x1000);
            }

            if (!clearUntil) {
                // safe bet in case the first refKey returned something strange
                clearUntil = Date.now() - 10 * 24 * 3600 * 1000; // anything older than last 10 days
            } else {
                // remove messages stored before 10 minutes of the first id
                clearUntil -= 10 * 60 * 1000;
            }

            this.deleteRange({
                gt: 'message ',
                lt: 'message ' + this.seqIndex.getByTime(clearUntil) + '0000 ~'
            }, callback);
        });
    }

    /**
     * Method that perdiodically checks and removes garbage
     */
    checkGarbage() {
        clearTimeout(this.garbageTimer);
        this.clearGarbage(err => {
            if (err) {
                log.error('GC', err);
            }
            this.garbageTimer = setTimeout(() => this.checkGarbage(), 60 * 60 * 1000);
            this.garbageTimer.unref();
        });
    }

    /**
     * Starts periodic tasks
     */
    startPeriodicCheck() {
        this.stopPeriodicCheck();
        setImmediate(() => this.checkDeferred());
        setImmediate(() => this.checkGarbage());
    }

    /**
     * Stops periodic tasks
     */
    stopPeriodicCheck() {
        clearTimeout(this.deferTimer);
        clearTimeout(this.garbageTimer);
        this.deferTimer = null;
        this.garbageTimer = null;
    }

    listQueued(type, zone, maxItems, callback) {

        let returned = false;
        let gt, lt;
        let list = [];

        if (zone) {
            gt = 'delivery-zone ' + encodeURIComponent(zone) + ' ';
            lt = 'delivery-zone ' + encodeURIComponent(zone) + ' ~';
        } else {
            gt = 'delivery-zone ';
            lt = 'delivery-zone ~';
        }

        if (type === 'deferred') {
            gt = 'deferred:key ' + gt;
            lt = 'deferred:key ' + lt;
        }

        let stream = this.db.createReadStream({
            gt,
            lt,
            keys: true,
            values: false,
            limit: maxItems || 1000
        });

        stream.on('data', key => {
            if (returned) {
                return;
            }
            if (this.closing) {
                returned = true;
                stream.destroy();
                return callback(new Error('Server shutdown in progress'));
            }

            // 'delivery-zone ' + encodeURIComponent(deliveryZone) + ' ' + id + ' ' + encodeURIComponent(recipient)
            let keyParts = key.split(' ');
            if (type === 'deferred') {
                keyParts.shift();
            }

            list.push({
                id: keyParts[2] || '',
                zone: decodeURIComponent(keyParts[1] || ''),
                recipient: decodeURIComponent(keyParts[3] || '')
            });

        }).once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        }).on('end', () => {
            if (returned) {
                return;
            }
            returned = true;
            callback(null, list);
        });
    }

    count(type, key, counter, callback) {
        let returned = false;
        let rows = 0;

        let groups = new Map();

        let gt, lt;
        let keyIndex = counter === 'deferred' ? 2 : 1;

        switch (type) {
            case 'zone':
                if (key) {
                    gt = 'delivery-zone ' + encodeURIComponent(key) + ' ';
                    lt = 'delivery-zone ' + encodeURIComponent(key) + ' ~';
                } else {
                    gt = 'delivery-zone ';
                    lt = 'delivery-zone ~';
                }
                if (counter === 'deferred') {
                    gt = 'deferred:key ' + gt;
                    lt = 'deferred:key ' + lt;
                }
                break;
            case 'domain':
                if (key) {
                    gt = 'delivery-domain ' + encodeURIComponent(key) + ' ';
                    lt = 'delivery-domain ' + encodeURIComponent(key) + ' ~';
                } else {
                    gt = 'delivery-domain ';
                    lt = 'delivery-domain ~';
                }
                if (counter === 'deferred') {
                    gt = 'deferred:domain ' + gt;
                    lt = 'deferred:domain ' + lt;
                }
                break;
            default:
                return setImmediate(() => callback(new Error('Unknown counter type')));
        }

        let stream = this.db.createReadStream({
            gt,
            lt,
            keys: true,
            values: false
        });

        stream.on('data', key => {
            if (returned) {
                return;
            }
            if (this.closing) {
                returned = true;
                stream.destroy();
                return callback(new Error('Server shutdown in progress'));
            }

            let parts = key.split(' ');
            let entry = parts[keyIndex] || '';

            if (!groups.has(entry)) {
                groups.set(entry, 1);
            } else {
                groups.set(entry, groups.get(entry) + 1);
            }

            rows++;
        }).once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        }).on('end', () => {
            if (returned) {
                return;
            }
            returned = true;

            let result = {
                entries: [],
                rows
            };

            groups.forEach((value, entry) => {
                result.entries.push({
                    key: decodeURIComponent(entry),
                    value
                });
            });

            callback(null, result);
        });
    }

    /**
     * Stops all timers and closes database
     *
     */
    stop() {
        this.closing = true;
        this.iterators.forEach(iterator => {
            iterator.close();
        });
        this.stopPeriodicCheck();
    }

    /**
     * Start periodic tasks (garbage colletion and retrieveing deferred elements)
     *
     * @param {Function} callback Run once everything is started
     */
    init(callback) {
        let returned = false;
        if (!this.db) {
            mkdirp(this.options.db, err => {
                if (err) {
                    log.error('Queue', 'Could not initialize queue folder: %s', err.message);
                    return;
                }

                let opts = {};
                Object.keys(this.options[this.options.backend] || {}).forEach(key => {
                    opts[key] = this.options[this.options.backend][key];
                });
                opts.db = require(this.options.backend); // eslint-disable-line global-require

                this.db = levelup(this.options.db, opts);

                this.db.on('ready', () => {
                    if (returned) {
                        log.error('Queue', 'Managed to open database but it was already errored');
                        return;
                    }
                    returned = true;
                    if (!this.streamer) {
                        this.streamer = levelStreamAccess(this.db);
                    }
                    this.startPeriodicCheck();
                    return setImmediate(() => callback(null, true));
                });

                this.db.once('error', err => {
                    if (returned) {
                        return log.error('Queue', err);
                    }
                    returned = true;
                    callback(err);
                });
            });
        } else {
            if (!this.streamer) {
                this.streamer = levelStreamAccess(this.db);
            }
            this.startPeriodicCheck();
            return setImmediate(() => callback(null, true));
        }
    }

    // This shared iterator thing is a real mess. Badly needs refactoring. Might even cause memory leaks.
    // It is needed to optimize reading values from the delivery queue. Reading stuff in parallel ended up
    // in huge possibility of collisions and re-reading data in a O(n2)
    getSharedIterator(name, options) {
        if (!this.iterators.has(name)) {
            this.iterators.set(name, new SharedIterator(this, name, options));
        }
        return this.iterators.get(name);
    }

    generateId(callback) {
        setImmediate(() => callback(null, this.seqIndex.get()));
    }
}

// Expose to the world
module.exports = MailQueue;
