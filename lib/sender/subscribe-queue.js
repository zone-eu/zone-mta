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
    }

    setupSubscriber(subscriber) {
        this.subscriber = subscriber;
        this.amqp.createChannel((err, channel) => {
            if (err) {
                return this.emit('error', err);
            }
            this.channel = channel;

            channel.once('error', err => {
                log.error('AMQP', 'Channel error. %s', err.message);
                process.exit(1); // fail fast
            });

            channel.on('close', () => {
                log.info('AMQP', 'Channel closed');
                process.exit(1); // fail fast
            });

            channel.assertQueue(this.exchange);
            channel.assertQueue(this.exchange + ':deferred', {
                messageTtl: 3 * 60 * 60 * 1000,
                deadLetterExchange: this.exchange
            });

            console.log('CREATED CONSUMER')
            channel.consume(this.exchange, message => this.onMessage(channel, message), {
                noAck: false
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

    onMessage(channel, message) {
        let msgid = ++this.msgc;
        console.log('RETRIEVED MESSAGE %s [%s]', msgid, this.u);
        let content = (message.content || '').toString();
        let delivery;
        try {
            delivery = JSON.parse(content);
        } catch (E) {
            log.error('AMQP', 'Failed parsing input. %s', JSON.stringify(content));
            console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
            return channel.ack(message);
        }
        delivery.queueContent = message.content;

        this.locks.acquire(this.exchange, delivery.domain, delivery.id + '.' + delivery.seq, (err, lock) => {
            if (err) {
                log.error('Lock', '%s.%s Failed retrieving lock. %s', delivery.id, delivery.seq, err.message);
                return setTimeout(() => {
                    console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
                    channel.nack(message, false, true)
                }, 5000).unref();
            }

            if (!lock) {
                log.info('Lock', '%s.%s Failed retrieving lock %s', delivery.id, delivery.seq, this.u);
                return setTimeout(() => {
                    console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
                    channel.nack(message, false, true);
                }, 1000).unref();
            }

            log.info('Lock', '%s.%s acquired for %s', delivery.id, delivery.seq, delivery.domain);

            this.getMeta(delivery.id, (err, meta) => {

                if (err) {
                    log.error('AMQP', '%s.%s Failed retrieving meta. %s', delivery.id, delivery.seq, err.message);
                    return setTimeout(() => {
                        console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
                        channel.nack(message, false, true)
                    }, 1000);
                }

                if (!meta) {
                    log.error('AMQP', '%s.%s Meta not found for message', delivery.id, delivery.seq);
                    console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
                    channel.ack(message);
                    return channel.nack(message, false, true);
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
                        lock.release(() => {
                            console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
                            log.verbose('Lock', '%s.%s released for %s', delivery.id, delivery.seq, delivery.domain);
                            channel.ack(message);
                        });
                    },
                    nack: () => {
                        if (released) {
                            log.verbose('AMQP', '%s.%s Trying to re-release NACK', delivery.id, delivery.seq);
                            return;
                        }
                        released = true;
                        lock.release(() => {
                            console.log('RELEASED MESSAGE %s [%s]', msgid, this.u);
                            log.verbose('Lock', '%s.%s released for %s', delivery.id, delivery.seq, delivery.domain);
                            channel.nack(message, false, true);
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
