'use strict';

const config = require('wild-config');
const log = require('npmlog');
const sendingZone = require('./sending-zone');
const Server = require('./transport/server');
const MailDrop = require('./mail-drop');
const plugins = require('./plugins');
const Headers = require('mailsplit').Headers;

// setup prometheus probes
const promClient = require('prom-client');
const deliveryStatusCounter = new promClient.Counter({
    name: 'zonemta_delivery_status',
    help: 'Delivery status',
    labelNames: ['result']
});
const messagePushCounter = new promClient.Counter({
    name: 'zonemta_message_push',
    help: 'Messages pushed to queue',
    labelNames: ['result']
});
const bounceCounter = new promClient.Counter({
    name: 'zonemta_bounce_generation',
    help: 'Bounce generation'
});
const dropCounter = new promClient.Counter({
    name: 'zonemta_message_drop',
    help: 'Messages dropped'
});

class QueueServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.clients = new WeakMap();
        this.maildrop = new MailDrop();
        this.createServer();
    }

    setQueue(queue) {
        this.queue = this.maildrop.queue = queue;
    }

    createServer() {
        this.server = new Server();
        this.server.on('client', client => {
            client.responseHandlers = new Map();
            client.zone = false;
            client.smtp = false;
            client.id = false;

            client.on('close', () => {
                if (client && client.id) {
                    this.queue.locks.releaseLockOwner(client.id);
                }
                client = null;
            });

            client.once('error', () => {
                if (client && client.id) {
                    this.queue.locks.releaseLockOwner(client.id);
                }
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
                    if (data.zone) {
                        client.zone = sendingZone.get(data.zone);
                        if (!client.zone) {
                            client.send({
                                error: 'Selected Sending Zone does not exist'
                            });
                            return client.close();
                        }
                    }

                    // everything OK
                    return;
                }

                if (!data.req) {
                    // ignore
                    return;
                }

                if (!this.queue) {
                    return client.send({
                        req: data.req,
                        error: 'Service not yet started'
                    });
                }

                switch (data.cmd) {
                    case 'GET':
                        if (!client.zone) {
                            return client.send({
                                req: data.req,
                                error: 'Zone not set'
                            });
                        }
                        return this.findNext(client.zone, client.id, data, (err, delivery) => {
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }

                            if (delivery) {
                                delivery.disabledAddresses = client.zone.domainConfig.get(delivery.domain, 'disabledAddresses');
                                delivery.dnsOptions = client.zone.domainConfig.get(delivery.domain, 'dnsOptions') || {};
                                delivery.logger = client.zone.domainConfig.get(delivery.domain, 'logger') || false;
                            }

                            client.send({
                                req: data.req,
                                response: delivery
                            });
                        });

                    case 'RELEASE': {
                        if (!client.zone) {
                            return client.send({
                                req: data.req,
                                error: 'Zone not set'
                            });
                        }
                        let deliveryStatus = 'unknown';
                        if (data && data.status) {
                            deliveryStatus = data.status.delivered ? 'delivered' : 'rejected';
                        }
                        deliveryStatusCounter.inc({
                            status: deliveryStatus
                        });
                        return this.releaseDelivery(client.zone, client.id, data, (err, response) => {
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }
                            plugins.handler.runHooks(
                                'queue:release',
                                [client.zone, data],
                                () =>
                                    client &&
                                    client.send({
                                        req: data.req,
                                        response
                                    })
                            );
                        });
                    }
                    case 'DEFER':
                        if (!client.zone) {
                            return client.send({
                                req: data.req,
                                error: 'Zone not set'
                            });
                        }
                        deliveryStatusCounter.inc({
                            status: 'deferred'
                        });
                        return this.deferDelivery(client.zone, client.id, data, (err, response) => {
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }
                            client.send({
                                req: data.req,
                                response
                            });
                        });

                    case 'BOUNCE':
                        {
                            bounceCounter.inc();
                            let bounce = data;
                            bounce.headers = new Headers(bounce.headers || []);
                            plugins.handler.runHooks(
                                'queue:bounce',
                                [bounce, this.maildrop],
                                () =>
                                    client &&
                                    client.send({
                                        req: data.req,
                                        response: true
                                    })
                            );
                        }
                        break;

                    case 'REMOVE':
                        dropCounter.inc();
                        this.queue.removeMessage(data.id, err => {
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }
                            client.send({
                                req: data.req,
                                response: true
                            });
                        });
                        break;

                    case 'INDEX':
                        this.queue.generateId((err, id) => {
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }
                            client.send({
                                req: data.req,
                                response: id
                            });
                        });
                        break;

                    case 'SETMETA':
                        this.queue.setMeta(data.id, data.data, err => {
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }
                            client.send({
                                req: data.req,
                                response: true
                            });
                        });
                        break;

                    case 'PUSH':
                        this.queue.push(data.id, data.envelope, err => {
                            messagePushCounter.inc({
                                result: err ? 'fail' : 'success'
                            });
                            if (!client) {
                                // client already errored or closed
                                return;
                            }
                            if (err) {
                                return client.send({
                                    req: data.req,
                                    error: err.message || err
                                });
                            }
                            client.send({
                                req: data.req,
                                response: true
                            });
                        });
                        break;

                    case 'SETCACHE':
                        // caches a value to the shared cache
                        if (data.key) {
                            this.queue.cache.set(data.key, data.value, data.ttl);
                        }
                        client.send({
                            req: data.req,
                            response: true
                        });
                        break;

                    case 'GETCACHE':
                        // fetches a value from the shared cache
                        client.send({
                            req: data.req,
                            response: this.queue.cache.get(data.key)
                        });
                        break;

                    case 'CLEARCACHE':
                        // clears a key from shared cache
                        if (data.key) {
                            this.queue.cache.remove(data.key);
                        }
                        client.send({
                            req: data.req,
                            response: true
                        });
                        break;
                }
            };
        });
    }

    start(callback) {
        if (!config.queueServer.enabled) {
            return setImmediate(() => callback(null, false));
        }

        let returned = false;
        this.server.once('error', err => {
            if (returned) {
                return log.error('QS', err);
            }
            returned = true;
            return callback(err);
        });

        this.server.listen(config.queueServer.port, config.queueServer.host, () => {
            if (returned) {
                return this.server.close();
            }
            returned = true;
            callback(null, true);
        });
    }

    close(callback) {
        this.closing = true;
        this.server.close(callback);
    }

    // Finds and locks details for next delivery
    findNext(zone, lockOwner, req, callback) {
        zone.getNextDelivery(lockOwner, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (!delivery) {
                return callback(null, false);
            }

            this.queue.getMeta(delivery.id, (err, meta) => {
                if (err) {
                    this.queue.locks.release(delivery._lock);
                    return callback(err);
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

                return callback(null, data);
            });
        });
    }

    // Marks a delivery as done (either bounced or accepted)
    // Does not check the validity of instance id since we need this data
    releaseDelivery(zone, lockOwner, req, callback) {
        this.queue.getDelivery(req.id, req.seq, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (!delivery) {
                return callback(null, false);
            }

            delivery._lock = req._lock;

            zone.releaseDelivery(delivery, err => {
                if (err) {
                    return callback(err);
                }
                return callback(null, delivery.id + '.' + delivery.seq);
            });
        });
    }

    // Marks a delivery as deferred
    // Does not check the validity of instance id since we need this data
    deferDelivery(zone, lockOwner, req, callback) {
        this.queue.getDelivery(req.id, req.seq, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (!delivery) {
                return callback(null, false);
            }

            delivery._lock = req._lock;
            zone.deferDelivery(delivery, Number(req.ttl), req, err => {
                if (err) {
                    return callback(err);
                }
                return callback(null, delivery.id + '.' + delivery.seq);
            });
        });
    }
}

module.exports = QueueServer;
