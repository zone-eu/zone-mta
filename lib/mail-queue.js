'use strict';

const config = require('config');
const levelup = require('levelup');
const levelStreamAccess = require('level-stream-access');
const log = require('npmlog');
const sendingZone = require('./sending-zone');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

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
        this.db = this.options.db;
        this.closing = false;
        this.streamer = false;
        this.seqCounter = Date.now();
        this.deferTimer = null;
        this.garbageTimer = null;

        this.stats = {
            totalQueued: 0,
            domainQueued: new Map(),
            zoneQueued: new Map()
        };

        this.instanceId = this.genIndex().toString();

        // Use in memory locking. If a key exists in Map, then lock is set,
        // otherwise there is no lock for the resource
        // Previously locks were stored in leveldb but it only made things slower
        // Map key is lock key and map value is lock expire time
        this.locks = new Map();

        // To be able to delete locks on bulk we store common identifier (eg. the id of the owner of the lock)
        // in this map
        this.lockOwners = new Map();

        // To be able to limit which domains are returned from the queue
        // we store current domain data in this map instance. Map key is zone name+domain name,
        // value is expire time. Normally the expire time should never be reached
        this.skipDomains = new Map();
    }

    /**
     * Generates a unique sequential ID value based on current time. Sequential
     * ID values are needed for sorting in leveldb
     *
     * @return {Number} Sequential numeric ID
     */
    genIndex() {
        let index = this.seqCounter++;
        return (Date.now() * 0x1000 + (index & 0xfff)); // eslint-disable-line no-bitwise
    }

    /**
     * Stores a stream (eg. an email message) into the backend storage
     *
     * @param  {Stream}   stream   Stream data to store
     * @param  {Function} callback Returns with (err, id)
     */
    store(stream, callback) {
        if (this.closing) {
            // nothing to do here
            return callback(new Error('Server shutdown in progress'));
        }

        let id = this.genIndex().toString();
        let returned = false;
        let store = this.streamer.createWriteStream('message ' + id);

        stream.on('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            callback(err);
        });

        store.on('error', err => {
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
     * Inject data to the beginning of the stored message. This is needed to inject
     * the headers part of the message
     *
     * @param {String} id The ID of the stored data
     * @param {Buffer/String} data Data to inject to the beginning of the stored message
     * @param {Function} callback
     */
    storePrepend(id, data, callback) {
        // we do not know the exact start time but we can assume it is about the
        // same as the id itself, so whenever we need to inject something to the beginning
        // we need to come up with a key lower than previous one. This way we can add as many
        // chunks we want to
        let keydiff = id - (this.genIndex() - id);
        this.db.put('message ' + id + ' ' + keydiff, data, callback);
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
     * Checks if a message exists
     *
     * @param {String} id Id of the stored data
     * @param {Function} callback Function to run with the boolean result
     */
    messageExists(id, callback) {
        this.getFirst({
            gt: 'message ' + id + ' ',
            lt: 'message ' + id + ' ~',
            keys: true,
            values: false
        }, (err, key) => {
            if (err) {
                return callback(err);
            }
            return callback(null, !!key);
        });
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

        let seq = 0;
        let ops = [];

        // split recipient list into separate deliveries
        recipients.forEach(recipient => {
            let deliveryZone;
            let recipientDomain = recipient.substr(recipient.lastIndexOf('@') + 1);
            let senderDomain = (envelope.headers.from || envelope.from || '').split('@').pop();

            deliveryZone = zone;

            // try to route by From domain
            if (!deliveryZone && senderDomain) {
                // if sender domain is not routed, then returns false
                deliveryZone = sendingZone.findBySender(senderDomain);
            }

            // try to route by recipient domain
            if (!deliveryZone && recipientDomain) {
                // if recipient domain is not routed, then returns false
                deliveryZone = sendingZone.findByRecipient(recipientDomain);
            }

            // still nothing, use default
            if (!deliveryZone) {
                deliveryZone = 'default';
            }

            seq++;
            let deliverySeq = (seq < 0x100 ? '0' : '') + (seq < 0x10 ? '0' : '') + seq.toString(16);
            let delivery = {

                // Store indexing keys in the delivery object
                // sort by Zone
                _key: 'delivery ' + encodeURIComponent(deliveryZone) + ' ' + id + ' ' + encodeURIComponent(recipient),
                // sort by Domain
                _domainKey: 'delivery ' + encodeURIComponent(recipientDomain) + ' ' + encodeURIComponent(deliveryZone) + ' ' + id + ' ' + encodeURIComponent(recipient),
                // reference for ID
                _refKey: 'ref ' + id + ' ' + encodeURIComponent(deliveryZone) + ' ' + encodeURIComponent(recipient),
                // reference for ID + SEQ
                _seqKey: 'seq ' + id + ' ' + deliverySeq,

                // Actual delivery data
                domain: recipientDomain,
                id,
                sendingZone: deliveryZone,
                seq: deliverySeq,
                to: recipient
            };

            // add user defined envelope data
            Object.keys(envelope).forEach(key => {
                if (!delivery.hasOwnProperty(key)) {
                    delivery[key] = envelope[key];
                }
            });

            // Keep references against a message id. Once there are no more references
            // against a message ID, the message can be safely deleted. This is also the
            // key we use to store the delivery data
            ops.push({
                type: 'put',
                key: delivery._refKey,
                value: JSON.stringify(delivery)
            });

            // List all remaining deliveries for a zone sorted by message id
            // Needed to find deliveries by Zone
            ops.push({
                type: 'put',
                key: delivery._key,
                value: delivery._refKey
            });

            // List all remaining deliveries for a zone sorted by domain and message id
            // Needed to find deliveries by Zone + domain
            ops.push({
                type: 'put',
                key: delivery._domainKey,
                value: delivery._refKey
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
                messageId: delivery.messageId,
                from: delivery.from,
                to: delivery.to,
                source: envelope.origin
            });
            this.incStats(delivery.sendingZone, recipientDomain);
        });

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

        let domain = options.domain || false;
        let index, end;
        let lockOwner = options.lockOwner || false;

        if (!domain) {
            // index by zone
            index = 'delivery ' + encodeURIComponent(zone) + ' ';
            end = 'delivery ' + encodeURIComponent(zone) + ' ~';
        } else {
            // index by zone + domain
            index = 'delivery ' + encodeURIComponent(domain) + ' ' + encodeURIComponent(zone) + ' ';
            end = 'delivery ' + encodeURIComponent(domain) + ' ' + encodeURIComponent(zone) + ' ~';
        }

        // how many elements to proces at once to find a key that is not yet locked
        let batchSize = 5;

        // loop function to page through all the keys to find first matching
        let tryNext = () => {
            let returned = false; // indicates that we do not need to process remaining events
            let received = 0; // counts how many elements we have processed

            this.db.createReadStream({
                gt: index,
                lt: end,
                keys: true,
                values: true,
                limit: batchSize
            }).on('data', data => {
                if (returned) {
                    // already found a match or errored
                    return;
                }

                received++;
                index = data.key; // update index for next batch

                // all indexing keys end with ' [id] [recipient]'
                let keyParts = data.key.split(' ');
                let recipient = decodeURIComponent(keyParts.pop());
                let deliveryDomain = recipient.substr(recipient.lastIndexOf('@') + 1); // domains in keys are already normalized
                let id = keyParts.pop();
                let lockKey = 'message ' + id + ' ' + encodeURIComponent(recipient);

                let refKey = data.value;
                let key;
                let domainKey;

                if (domain) {
                    domainKey = data.key;
                    key = data.key.replace(/^delivery [^\s]+/, 'delivery');
                } else {
                    key = data.key;
                    domainKey = data.key.replace(/^delivery /, 'delivery ' + data.key.split('%40').pop() + ' ');
                }

                // check if the key is already locked
                if ((!domain && this.isSkipDomain(zone, deliveryDomain)) || !this.acquireLock(lockKey, lockOwner)) {
                    // nothing to do here, already locked by someone else
                    return;
                }

                // we have a winner, the domain was not overloaded and we managed to acquire a lock
                returned = true; // next 'data' and 'end' events are ignored

                // try to fetch contents for the key
                // actual value key is stored as the value of the indexing key ('ref …')
                this.db.get(refKey, (err, value) => {
                    if (err) {
                        if (err.name === 'NotFoundError') {
                            this.releaseLock(lockKey);
                            // this situation might happen if we recovered a deferred delivery that was already processed
                            return this.releaseDelivery({
                                _key: key,
                                _domainKey: domainKey,
                                _refKey: refKey,
                                _lock: lockKey
                            }, err => {
                                if (err) {
                                    return callback(err);
                                }
                                setImmediate(tryNext);
                            });
                        }
                        return callback(err);
                    }

                    let delivery;
                    try {
                        delivery = JSON.parse(value);
                    } catch (E) {
                        // Should never happen but just in case quarantine the invalid value
                        log.error('Queue', 'Broken JSON string for key "%s"', refKey);
                        log.error('Queue', E);
                        let ops = [{
                            type: 'del',
                            key: refKey
                        }, {
                            type: 'put',
                            key: 'quarantined ' + refKey,
                            value
                        }];
                        // Delete the invalid values and start over
                        return this.db.batch(ops, () => {
                            this.releaseLock(lockKey);
                            tryNext();
                        });
                    }

                    // Store used lock key in the delivery object
                    delivery._lock = lockKey;
                    callback(null, delivery);
                });
            }).on('error', err => {
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

                if (received < batchSize) {
                    // We received less than expected, this means we reached the end of the results
                    if (domain && !options.toDomainOnly) {
                        // Retry without domain
                        domain = false;
                        index = 'delivery ' + encodeURIComponent(zone) + ' ';
                        end = 'delivery ' + encodeURIComponent(zone) + ' ~';
                    } else {
                        // We only end up here if we scanned through all keys and found nothing
                        return callback(null, false);
                    }
                }
                setImmediate(tryNext);
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
            this.db.get(refKey, (err, value) => {
                if (err) {
                    if (err.name === 'NotFoundError') {
                        return callback(null, false);
                    }
                    return callback(err);
                }
                if (!refKey) {
                    return callback(null, false);
                }
                let delivery;
                try {
                    delivery = JSON.parse(value);
                } catch (E) {
                    return callback(E);
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

        this.db.createReadStream(query).on('data', data => {
            if (returned) {
                return;
            }
            response.push(data);
        }).on('error', err => {
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

        keys.on('error', err => {
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
     * Set lock for a key. Lock must be later released using the same key. Locks older than 10min are
     * released automatically
     *
     * @param {String} key Lock identifier
     * @param {String} lockOwner Some identifier for releasing locks in bulk
     * @return {Boolean} Returns true if it was able to set the lock or false if lock already existed
     */
    acquireLock(key, lockOwner) {
        if (this.locks.has(key)) {
            let lock = this.locks.get(key);
            if (lock.ttl < Date.now()) {
                this.releaseLock(key);
            } else {
                return false;
            }
        }

        // Lock expires in ten minutes. This is how much we got to connect and deliver this message
        this.locks.set(key, {
            ttl: Date.now() + 10 * 60 * 1000,
            lockOwner
        });

        if (lockOwner) {
            if (!this.lockOwners.has(lockOwner)) {
                this.lockOwners.set(lockOwner, new Set());
            }
            this.lockOwners.get(lockOwner).add(key);
        }

        return true;
    }

    /**
     * Releases a lock for a delivery item
     *
     * @param {String/Object} data Either locking key or a delivery object
     */
    releaseLock(data) {
        let key;

        if (data && typeof data === 'object') {
            if (data._lock) {
                key = data._lock;
                data._lock = null;
            }
        } else {
            key = data;
        }

        if (!key) {
            return false;
        }

        let lock = this.locks.get(key);
        if (lock && lock.lockOwner) {
            let owner = this.lockOwners.get(lock.lockOwner);
            if (owner) {
                owner.delete(key);
                if (!owner.size) {
                    this.lockOwners.delete(lock.lockOwner);
                }
            }
        }

        return this.locks.delete(key);
    }

    /**
     * Releases locks in bulk based on the owner ID. This happens if a child dies and we need to
     * release all locks by that client
     *
     * @param {String} owner Lock owner id
     */
    releaseLocksByOwner(owner) {
        if (!this.lockOwners.has(owner)) {
            return false;
        }
        let locks = this.lockOwners.get(owner);
        locks.forEach(lock => {
            this.releaseLock(lock);
        });
        return true;
    }

    /**
     * Marks a domain name as on hold
     *
     * @param {String} zone Sending Zone identifier
     * @param {String} domain Domain name to check for
     */
    skipDomain(zone, domain) {
        if (!domain) {
            return false;
        }
        // lock domain up to 10 minutes
        // so if a sender process dies in between it is going to take up to 10
        // minutes to recover
        return this.skipDomains.set(zone + ' ' + domain, Date.now() + 10 * 60 * 1000);
    }

    /**
     * Removes a domain name from the on hold list
     *
     * @param {String} zone Sending Zone identifier
     * @param {String} domain Domain name to check for
     */
    releaseDomain(zone, domain) {
        if (!domain) {
            return false;
        }
        return this.skipDomains.delete(zone + ' ' + domain);
    }

    /**
     * Checks if a domain is put on hold
     *
     * @param {String} zone Sending Zone identifier
     * @param {String} domain Domain name to check for
     * @return {Boolean} Returns true if the domain is on hold
     */
    isSkipDomain(zone, domain) {
        if (!domain) {
            return false;
        }
        if (!this.skipDomains.has(zone + ' ' + domain)) {
            return false;
        }
        let ttl = this.skipDomains.get(zone + ' ' + domain);
        if (ttl && ttl < Date.now()) {
            this.skipDomains.delete(zone + ' ' + domain);
            return false;
        }
        return true;
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
                key: delivery._key
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

        if (delivery.sendingZone && delivery.domain) {
            this.decStats(delivery.sendingZone, delivery.domain);
        }

        this.db.batch(ops, {
            sync: true
        }, err => {
            if (err) {
                return callback(err);
            }

            // safe to remove lock
            this.releaseLock(delivery);

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
     * @param {Function} callback Run once the message is removed from active queue
     */
    deferDelivery(delivery, ttl, callback) {

        // add metainfo about postponing the delivery
        delivery._deferred = delivery._deferred || {
            first: Date.now(),
            count: 0
        };
        delivery._deferred.count++;
        delivery._deferred.last = Date.now();
        delivery._deferred.next = (Date.now() + ttl);

        let ops = [
            // move delivery
            {
                // remove from zone based queue
                type: 'del',
                key: delivery._key
            }, {
                // remove from zone+domain based queue
                type: 'del',
                key: delivery._domainKey
            }, {
                // update value
                type: 'put',
                key: delivery._refKey,
                value: JSON.stringify(delivery)
            }, {
                // add to defer queue
                type: 'put',
                key: 'deferred:item ' + delivery._deferred.next + ' ' + this.genIndex(),
                value: [delivery._key, delivery._domainKey, delivery._refKey].join('\n')
            }, {
                // mark key as deferred
                // useful for finding deferred messages for a zone
                type: 'put',
                key: 'deferred:key ' + delivery._key,
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

            // increment deferred counter
            this.incDeferred(delivery.sendingZone, delivery.domain);

            // safe to remove the lock
            this.releaseLock(delivery);

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
            let data;
            let ops = [];
            while ((data = stream.read()) !== null) {
                let lines = data.value.split('\n');
                let key = lines.shift();
                let domainKey = lines.shift();
                let refKey = lines.join('\n');
                processed++;

                // recover original delivery item
                ops.push({
                    type: 'put',
                    key,
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
                    key: 'deferred:key ' + key
                });
                ops.push({
                    type: 'del',
                    key: 'deferred:domain ' + domainKey
                });

                // decrement deferred counter
                let keyParts = key.split(' ');
                this.decDeferred(keyParts[1] || '', (keyParts[3] || '').split('%40').pop());
            }
            this.db.batch(ops);
        });

        stream.on('error', err => {
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
                log.info('Queue', 'Recovered %s TTLed items', processed);
            }
            let nextCheck = 15 * 1000;
            log.silly('Queue', 'Next TTL recovery check in %s s', nextCheck / 1000);
            this.deferTimer = setTimeout(() => this.checkDeferred(), nextCheck);
        });
    }

    /**
     * Removes old messages without checking if there are any references left (there shouldn't be)
     *
     * @param {Function} callback Runs once the keys have been removed
     */
    clearGarbage(callback) {
        // iterate over existing locks and remove expired ones
        for (let entry of this.locks) {
            if (entry[1] < Date.now()) {
                this.locks.delete(entry[0]);
            } else {
                // iterators use insertion ordering, so once we reach to a value
                // that is not expired there can't be non-expired values left
                break;
            }
        }

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
                clearUntil = Date.now() * 0x1000;
            } else {
                let keyParts = refKey.split(' ');
                keyParts.shift();
                clearUntil = Number(keyParts.shift()) || 0;
            }

            if (!clearUntil) {
                // safe bet in case the first refKey returned something strange
                clearUntil = (Date.now() - (10 * 24 * 3600 * 1000)) * 0x1000; // anything older than last 10 days
            } else {
                // remove messages stored before 10 minutes of the first id
                clearUntil -= 10 * 60 * 1000 * 0x1000;
            }

            this.deleteRange({
                gt: 'message ',
                lt: 'message ' + clearUntil + ' ~'
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
            this.deferTimer = setTimeout(() => this.checkGarbage(), 60 * 60 * 1000);
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

    incDeferred(zone, domain) {
        if (this.stats.domainQueued.has(domain)) {
            this.stats.domainQueued.get(domain).deferred++;
        }
        if (this.stats.zoneQueued.has(zone)) {
            this.stats.zoneQueued.get(zone).deferred++;
        }
        if (this.stats.zoneQueued.get(zone).domains.has(domain)) {
            this.stats.zoneQueued.get(zone).domains.get(domain).deferred++;
        }
    }

    decDeferred(zone, domain) {
        if (this.stats.domainQueued.has(domain) && this.stats.domainQueued.get(domain).deferred > 0) {
            this.stats.domainQueued.get(domain).deferred--;
        }
        if (this.stats.zoneQueued.has(zone) && this.stats.zoneQueued.get(zone).deferred > 0) {
            this.stats.zoneQueued.get(zone).deferred--;
            if (this.stats.zoneQueued.get(zone).domains.has(domain) && this.stats.zoneQueued.get(zone).domains.get(domain).deferred > 0) {
                this.stats.zoneQueued.get(zone).domains.get(domain).deferred--;
            }
        }
    }

    incStats(zone, domain) {
        this.stats.totalQueued++;

        // increment domain counter
        if (!this.stats.domainQueued.has(domain)) {
            this.stats.domainQueued.set(domain, {
                queued: 1,
                deferred: 0
            });
        } else {
            this.stats.domainQueued.get(domain).queued++;
        }

        // increment zone counter
        if (!this.stats.zoneQueued.has(zone)) {
            this.stats.zoneQueued.set(zone, {
                domains: new Map(),
                queued: 0,
                deferred: 0,
                started: Date.now(),
                processed: 0
            });
        }
        this.stats.zoneQueued.get(zone).queued++;

        // Increment zone+domain counter
        if (!this.stats.zoneQueued.get(zone).domains.has(domain)) {
            this.stats.zoneQueued.get(zone).domains.set(domain, {
                queued: 0,
                deferred: 0
            });
        }
        this.stats.zoneQueued.get(zone).domains.get(domain).queued++;
    }

    decStats(zone, domain) {
        if (this.stats.totalQueued > 0) {
            this.stats.totalQueued++;
        }

        // decrement domain counter
        if (this.stats.domainQueued.has(domain)) {
            if (--this.stats.domainQueued.get(domain).queued <= 0) {
                this.stats.domainQueued.delete(domain);
            }
        }

        // decrement zone counter
        if (this.stats.zoneQueued.has(zone)) {
            this.stats.zoneQueued.get(zone).processed++;
            if (--this.stats.zoneQueued.get(zone).queued <= 0) {
                this.stats.zoneQueued.get(zone).queued = 0;
                this.stats.zoneQueued.get(zone).deferred = 0;
            } else if (this.stats.zoneQueued.get(zone).domains.has(domain)) {
                if (--this.stats.zoneQueued.get(zone).domains.get(domain).queued <= 0) {
                    this.stats.zoneQueued.get(zone).domains.delete(domain);
                }
            }
        }
    }

    getLastState(done) {

        let updateQueueCounters = callback => {

            let returned = false;

            let stream = this.db.createReadStream({
                gt: 'ref ',
                lt: 'ref ~',
                keys: true,
                values: false
            });

            stream.on('readable', () => {
                if (returned) {
                    return;
                }
                let key;
                while ((key = stream.read()) !== null) {
                    let keyParts = key.split(' ');
                    this.incStats(keyParts[2] || '', (keyParts[3] || '').split('%40').pop());
                }
            });

            stream.on('error', err => {
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
                callback(null, true);
            });
        };

        let updateDeferredCounters = callback => {

            let returned = false;

            let stream = this.db.createReadStream({
                gt: 'deferred:domain ',
                lt: 'deferred:domain ~',
                keys: true,
                values: false
            });

            stream.on('readable', () => {
                if (returned) {
                    return;
                }
                let key;
                while ((key = stream.read()) !== null) {
                    let keyParts = key.split(' ');
                    this.incDeferred(keyParts[3] || '', (keyParts[2] || ''));
                }
            });

            stream.on('error', err => {
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
                callback(null, true);
            });
        };

        updateQueueCounters(err => {
            if (err) {
                return done(err);
            }
            updateDeferredCounters(done);
        });
    }

    /**
     * Checks an append log file and checks if stored entries need releasing.
     * Log file is deleted after check
     *
     * @param {String} filename Filename in the appendlog folder
     * @param {Function} callback Function to run once file is checked and removed
     */
    releaseUnacked(filename, callback) {
        let file = path.join(config.queue.appendlog, filename);
        let childId = filename.split('.').shift().split('-').pop();
        fs.readFile(file, 'utf-8', (err, lines) => {
            if (err) {
                // unacked file not found
                return callback();
            }

            lines = (lines || '').split('\n');
            let releaseNext = () => {
                if (!lines.length) {
                    this.releaseLocksByOwner(childId);
                    return fs.unlink(file, () => callback());
                }

                let line = lines.shift().trim();
                if (!line) {
                    return setImmediate(releaseNext);
                }

                let id = line.substr(0, line.lastIndexOf('.'));
                let seq = line.substr(line.lastIndexOf('.') + 1);

                log.info('Queue', 'Marking previously unacked delivery %s.%s as delivered', id, seq);

                this.getDelivery(id, seq, (err, delivery) => {
                    if (err || !delivery) {
                        return releaseNext();
                    }
                    this.releaseDelivery(delivery, () => {
                        // release possible locks if exist
                        delivery = null;
                        return releaseNext();
                    });
                });
            };
            releaseNext();
        });
    }

    /**
     * Finds all log files from the appendlog folder to check for unacked messages
     *
     * @param {Function} callback Function to run once all files are checked
     */
    checkUnacked(callback) {
        fs.readdir(config.queue.appendlog, (err, list) => {
            if (err || !list || !list.length) {
                return callback(null, false);
            }
            list = list.filter(file => /\.log$/.test(file));
            if (!list.length) {
                return callback(null, false);
            }

            let checkNextFile = () => {
                if (!list.length) {
                    return callback();
                }
                let fname = list.shift();
                this.releaseUnacked(fname, checkNextFile);
            };
            checkNextFile();
        });
    }

    /**
     * Stops all timers and closes database
     *
     * @param {Function} callback Function to run once the db is closed
     */
    stop(callback) {
        this.closing = true;
        this.stopPeriodicCheck();
        this.db.close(callback);
    }

    /**
     * Start periodic tasks (garbage colletion and retrieveing deferred elements)
     *
     * @param {Function} callback Run once everything is started
     */
    init(callback) {
        let returned = false;
        if (typeof this.db === 'string') {
            // DB is provided as path to folder, set up actual db instance
            this.db = levelup(this.db);

            this.db.on('ready', () => {
                if (returned) {
                    log.error('Queue', 'Managed to open database but it was already errored');
                    return;
                }
                returned = true;
                this.streamer = levelStreamAccess(this.db);
                this.startPeriodicCheck();
                this.checkUnacked(() => {
                    // update innerstats
                    this.getLastState(callback);
                });
            });

            this.db.on('error', err => {
                if (returned) {
                    return log.error('Queue', err);
                }
                returned = true;
                callback(err);
            });
            return;
        }
        // DB is already set up, no setup needed
        this.streamer = levelStreamAccess(this.db);
        this.startPeriodicCheck();
        this.checkUnacked(callback);
    }
}

// Expose to the world
module.exports = options => new MailQueue(options);
