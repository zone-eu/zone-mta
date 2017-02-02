'use strict';

const ZMTALocks = require('zmta-locks');
const EventEmitter = require('events');
const config = require('config');
const GridFs = require('grid-fs');
const log = require('npmlog');
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const amqplib = require('amqplib/callback_api');
const crypto = require('crypto');
const redis = require('redis');
const redisClient = redis.createClient(config.queue.redis);

const ttlMinutes = [
    5, /* 5 */
    7, /* 12 */
    8, /* 20 */
    25, /* 45 */
    75, /* 2h */
    120, /* 4h */
    240, /* 8h */
    240, /* 12h */
    240, /* 16h */
    240, /* 20h */
    240, /* 24h */
    240, /* 28h */
    240, /* 32h */
    240, /* 36h */
    240, /* 40h */
    240, /* 44h */
    240 /* 48h */
];

class SubscribeQueue extends EventEmitter {

    constructor(exchange) {
        super();
        this.u = crypto.randomBytes(5).toString('hex');
        this.o = 0;
        this.exchange = exchange || 'default';
        this.mongodb = false;
        this.gridstore = false;
        this.remoteClient = false;
        this.amqp = false;
        this.channel = false;
        this.locks = new ZMTALocks(config.queue);

        this.msgc = 0;

        this.FAILED = 0x01;
        this.BOUNCED = 0x02;
        this.REJECTED = 0x03;
        this.DEFERRED = 0x04;
        this.QUEUED = 0x05;
    }

    setupSubscriber(connections, consumerTag, subscriber) {
        this.subscriber = subscriber;
        this.amqp.createChannel((err, channel) => {
            if (err) {
                return this.emit('error', err);
            }
            this.channel = channel;

            channel.once('error', err => {
                log.error('AMQP', 'Channel error. %s', err.message);
                return process.exit(1); // fail fast
            });

            channel.on('close', () => {
                log.info('AMQP', 'Channel closed');
                return process.exit(1); // fail fast
            });

            channel.assertQueue(this.exchange, {
                durable: true
            }, err => {
                if (err) {
                    log.error('AMQP', 'Failed setting up channel "%s". %s', this.exchange, err.message);
                    return process.exit(1); // fail fast
                }
                channel.assertQueue(this.exchange + ':deferred', {
                    messageTtl: 3 * 60 * 60 * 1000,
                    deadLetterExchange: this.exchange
                }, err => {
                    if (err) {
                        log.error('AMQP', 'Failed setting up channel "%s". %s', this.exchange, err.message);
                        return process.exit(1); // fail fast
                    }

                    connections = Math.min(Math.max(Number(connections) || 1, 1), 1000);
                    channel.prefetch(connections);
                    channel.consume(this.exchange, message => this.onMessage(channel, message), {
                        noAck: false,
                        consumerTag
                    }, err => {
                        if (err) {
                            log.error('AMQP', 'Failed setting up consumer. %s', err.message);
                            return process.exit(1); // fail fast
                        }
                        log.info('AMQP', 'Set up consumer "%s" with prefetch %s', consumerTag, connections);
                    });
                });
            });
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

    getMeta(id, callback) {
        this.mongodb.collection(config.queue.gfs + '.files').findOne({
            filename: 'raw-' + id + '.eml'
        }, (err, item) => {
            if (err) {
                return callback(err);
            }
            return callback(null, item && item.metadata && item.metadata.data || false);
        });
    }

    retrieve(id) {
        return this.gridstore.createReadStream('raw-' + id + '.eml');
    }

    putOnHold(delivery, callback) {
        if (delivery._onHold) {
            return setImmediate(() => callback(null, false));
        }
        delivery._onHold = true;
        redisClient.hset('on:hold', delivery.id + '.' + delivery.seq, delivery.queueContent.toString('base64'), err => {
            if (err) {
                log.error('Redis', '%s.%s Failed storing message on hold. %s', delivery.id, delivery.seq, err.message);
                return callback(err);
            }
            callback(null, true);
        });
    }

    releaseOnHold(delivery, callback) {
        if (!delivery._onHold) {
            return setImmediate(() => callback(null, false));
        }
        redisClient.hdel('on:hold', delivery.id + '.' + delivery.seq, err => {
            if (err) {
                log.error('Redis', '%s.%s Failed removing message from hold queue. %s', delivery.id, delivery.seq, err.message || err);
                return callback(err);
            }
            callback(null, true);
        });
    }

    requeueOnHold(delivery, callback) {
        if (!delivery._onHold) {
            return setImmediate(() => callback(null, false));
        }
        redisClient.hget('on:hold', delivery.id + '.' + delivery.seq, (err, content) => {
            if (err) {
                log.error('Redis', '%s.%s Failed removing message from hold queue. %s', delivery.id, delivery.seq, err.message || err);
                return callback(err);
            }
            if (!content) {
                return callback(null, false);
            }
            this.requeueDelivery(Buffer.from(content, 'base64'), err => {
                if (err) {
                    log.error('Redis', '%s.%s Failed requeueing message from hold queue. %s', delivery.id, delivery.seq, err.message);
                    return callback(err);
                }
                redisClient.hdel('on:hold', delivery.id + '.' + delivery.seq, err => {
                    if (err) {
                        log.error('Redis', '%s.%s Failed removing message from hold queue. %s', delivery.id, delivery.seq, err.message || err);
                        return callback(err);
                    }
                    return callback(null, true);
                });
            });
        });
    }

    onMessage(channel, message) {
        let content = (message.content || '').toString();
        let delivery;
        try {
            delivery = JSON.parse(content);
        } catch (E) {
            log.error('AMQP', 'Failed parsing input. %s', JSON.stringify(content));
            return channel.ack(message);
        }
        delivery.queueContent = message.content;

        let ack = () => {
            channel.ack(message);
        };

        let nack = requeue => {
            channel.nack(message, false, requeue);
        };

        let lockTries = 0;
        let getLock = next => {
            log.info('Lock', '%s.%s Trying to acquire...', delivery.id, delivery.seq);
            this.locks.acquire(this.exchange, delivery.domain, delivery.id + '.' + delivery.seq, 5, (err, lock) => {
                if (err) {
                    return next(err);
                }
                if (!lock) {
                    lockTries++;

                    let ttl = Math.min(lockTries * 10, 1000);

                    if (!delivery._onHold && lockTries >= 15) {
                        return this.putOnHold(delivery, err => {
                            if (err) {
                                return process.exit(1);
                            }
                            channel.ack(message);

                            ack = () => {
                                this.releaseOnHold(delivery, err => {
                                    if (err) {
                                        return process.exit(1); // fail fast
                                    }
                                });
                            };

                            nack = () => {
                                this.requeueOnHold(delivery, err => {
                                    if (err) {
                                        return process.exit(1); // fail fast
                                    }
                                });
                            };

                            return setTimeout(() => getLock(next), 100 * 10);
                        });
                    }
                    log.info('Lock', '%s.%s Next lock retry in %s ms', delivery.id, delivery.seq, ttl);
                    return setTimeout(() => getLock(next), ttl);
                }
                next(null, lock);
            });
        };

        getLock((err, lock) => {
            if (err) {
                log.error('Lock', '%s.%s Failed retrieving lock. %s', delivery.id, delivery.seq, err.message);
                return setTimeout(() => {
                    nack(true);
                }, 1000).unref();
            }

            if (!lock) {
                log.info('Lock', '%s.%s Failed retrieving lock %s', delivery.id, delivery.seq, this.u);
                return setTimeout(() => {
                    this.requeueDelivery(delivery.queueContent, err => {
                        if (err) {
                            log.error('AMQP', '%s.%s Failed requeing locked message. %s', delivery.id, delivery.seq, err.message);
                        }
                        ack();
                        log.info('AMQP', '%s.%s Requeued locked message', delivery.id, delivery.seq);
                    });
                }, 1000).unref();
            }

            log.info('Lock', '%s.%s acquired for %s', delivery.id, delivery.seq, delivery.domain);

            this.getMeta(delivery.id, (err, meta) => {

                if (err) {
                    log.error('AMQP', '%s.%s Failed retrieving meta. %s', delivery.id, delivery.seq, err.message);
                    return setTimeout(() => {
                        nack(true);
                    }, 1000);
                }

                if (!meta) {
                    log.error('AMQP', '%s.%s Meta not found for message', delivery.id, delivery.seq);
                    ack();
                    return;
                }

                Object.keys(meta).forEach(key => {
                    delivery[key] = meta[key];
                });

                log.verbose('Queue', '%s.%s SHIFTED from queue', delivery.id, delivery.seq);

                let released = false;
                this.subscriber(delivery, {
                    ack: () => {
                        if (released) {
                            log.verbose('AMQP', '%s.%s Trying to re-release ACK', delivery.id, delivery.seq);
                            return;
                        }
                        released = true;

                        if (delivery._onHold) {
                            this.releaseOnHold(delivery, err => {
                                if (err) {
                                    return process.exit(1); // fail fast
                                }
                            });
                        } else {
                            lock.release(() => {
                                channel.ack(message);
                            });
                        }
                    },
                    nack: () => {
                        if (released) {
                            log.verbose('AMQP', '%s.%s Trying to re-release NACK', delivery.id, delivery.seq);
                            return;
                        }
                        released = true;
                        if (delivery._onHold) {
                            this.requeueOnHold(delivery, err => {
                                if (err) {
                                    return process.exit(1); // fail fast
                                }
                            });
                        } else {
                            lock.release(() => {
                                channel.nack(message, false, true);
                            });
                        }
                    },
                    // spcial method to put stuff on hold to be requeued later
                    continue: () => {
                        if (released) {
                            log.verbose('AMQP', '%s.%s Trying to re-set CONTINE', delivery.id, delivery.seq);
                            return;
                        }
                        if (delivery._onHold) {
                            // do nothing, already on hold
                            return;
                        }
                        this.putOnHold(delivery, err => {
                            if (err) {
                                return process.exit(1);
                            }
                            channel.ack(message);
                        });
                    }
                });
            });
        });
    }

    releaseDelivery(delivery, callback) {
        log.info('Release', '%s.%s FUTUFEAT Released delivery', delivery.id, delivery.seq);
        callback(null, true);
    }

    requeueDelivery(queueContent, callback) {
        let published = this.channel.sendToQueue(this.exchange,
            queueContent, {
                persistent: true,
                contentType: 'application/json'
            });

        if (published === false) {
            this.channel.once('drain', () => callback(null, this.QUEUED));
        } else {
            return setImmediate(() => callback(null, this.QUEUED));
        }
    }

    deferDelivery(queueContent, smtpResponse, callback) {
        if (!queueContent || !queueContent.length) {
            return setImmediate(() => callback(null, this.FAILED));
        }

        let content = (queueContent || '').toString();
        let delivery;
        try {
            delivery = JSON.parse(content);
        } catch (E) {
            log.error('AMQP', 'Failed parsing input. %s', JSON.stringify(content));
            return setImmediate(() => callback(null, this.FAILED));
        }

        delivery._deferred = delivery._deferred || {
            first: Date.now(),
            count: 0
        };
        let deferredCount = delivery._deferred.count;
        if (deferredCount >= ttlMinutes) {
            // reject
            return setImmediate(() => callback(null, this.BOUNCED));
        }

        let ttl = ttlMinutes[deferredCount] * 60 * 1000;
        delivery._deferred.count++;
        delivery._deferred.last = Date.now();
        delivery._deferred.next = (Date.now() + ttl);
        delivery._deferred.response = smtpResponse;

        let published = this.channel.sendToQueue(this.exchange + ':deferred',
            Buffer.from(JSON.stringify(content)), {
                persistent: true,
                contentType: 'application/json',
                expiration: ttl
            });

        if (published === false) {
            this.channel.once('drain', () => callback(null, this.DEFERRED));
        } else {
            return setImmediate(() => callback(null, this.DEFERRED));
        }
    }
}

module.exports = SubscribeQueue;
