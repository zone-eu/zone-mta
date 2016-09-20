'use strict';

const config = require('config');
const log = require('npmlog');
const sendingZone = require('./sending-zone');
const Server = require('./transport/server');
const MailDrop = require('./mail-drop');
const plugins = require('./plugins');

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
            client.id = false;

            client.on('close', () => {
                client = null;
            });

            client.on('error', () => {
                client = null;
            });

            client.onData = (data, next) => {
                setImmediate(next); // release immediatelly

                if (!client) {
                    // client already errored or closed
                    return;
                }

                if (data.cmd === 'HELLO') {
                    client.zone = sendingZone.get(data.zone);
                    client.id = data.id;

                    if (!client.zone) {
                        client.send({
                            error: 'Selected Sending Zone does not exist'
                        });
                        return client.close();
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
                        return this.findNext(client.zone, data, (err, delivery) => {
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
                                response: delivery
                            });
                        });

                    case 'RELEASE':
                        return this.releaseDelivery(client.zone, data, (err, response) => {
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

                    case 'DEFER':
                        return this.deferDelivery(client.zone, data, (err, response) => {
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
                            let bounce = data;
                            plugins.handler.runHooks('queue:bounce', [bounce, this.maildrop], () => client.send({
                                req: data.req,
                                response: true
                            }));
                        }
                }
            };

        });
    }

    start(callback) {
        if (!config.queueServer.enabled) {
            return setImmediate(() => callback(null, false));
        }

        let returned = false;
        this.server.on('error', err => {
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
    findNext(zone, req, callback) {
        zone.getNextDelivery(req.client, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (!delivery) {
                return callback(null, false);
            }

            this.queue.getMeta(delivery.id, (err, meta) => {
                if (err) {
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
    releaseDelivery(zone, req, callback) {
        this.queue.getDelivery(req.id, req.seq, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (!delivery) {
                return callback(new Error('Delivery not found'));
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
    deferDelivery(zone, req, callback) {
        this.queue.getDelivery(req.id, req.seq, (err, delivery) => {
            if (err) {
                return callback(err);
            }

            if (!delivery) {
                return callback('Delivery not found');
            }

            delivery._lock = req._lock;
            zone.deferDelivery(delivery, Number(req.ttl), err => {
                if (err) {
                    return callback(err);
                }
                return callback(null, delivery.id + '.' + delivery.seq);
            });
        });
    }
}

module.exports = options => new QueueServer(options);
