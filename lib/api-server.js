'use strict';

const config = require('config');
const log = require('npmlog');
const restify = require('restify');
const Headers = require('mailsplit').Headers;
const MailDrop = require('./mail-drop');
const plugins = require('./plugins');
const mailcomposer = require('mailcomposer');
const fs = require('fs');
const pathlib = require('path');
const util = require('util');

const lastBounces = [];

// Example DKIM keys for /get-config
const dkimKeys = new Map();
try {
    // Reads all *.pem files from ./keys
    fs.readdirSync(config.dkim.keys).filter(file => /\.pem$/.test(file)).forEach(file => {
        let privateKey = fs.readFileSync(pathlib.join(config.dkim.keys, file), 'utf-8');
        let parts = file.split('.');
        parts.pop();
        let keySelector = parts.pop();
        let domainName = parts.join('.');
        dkimKeys.set(domainName, {
            domainName,
            keySelector,
            privateKey
        });
    });
} catch (E) {
    log.error('DKIM', 'Was not able to load DKIM keys');
    log.error('DKIM', E);
}

class APIServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.maildrop = new MailDrop();
        this.createServer();
    }

    setQueue(queue) {
        this.queue = this.maildrop.queue = queue;
    }

    createServer() {
        this.server = restify.createServer();

        this.server.use(restify.authorizationParser());
        this.server.use(restify.queryParser());
        this.server.use(restify.gzipResponse());
        this.server.use(restify.bodyParser({
            mapParams: true
        }));

        this.server.pre((request, response, next) => {
            log.verbose('HTTP', request.url);
            next();
        });

        this.setupRoutes();
    }

    start(callback) {
        let returned = false;
        this.server.once('error', err => {
            if (returned) {
                return log.error('API', err);
            }
            returned = true;
            return callback(err);
        });

        this.server.listen(config.api.port, config.api.host, () => {
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

    setupRoutes() {

        // Example handler for authentication. You should probably override it
        // with the config.plugins['core/http-auth'].url option
        this.server.get('/test-auth', (req, res, next) => {
            let time = new Date().toISOString();

            if (req.username !== config.api.user || req.authorization.basic.password !== config.api.pass) {
                res.statusCode = 401;
                res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
                return res.json({
                    time,
                    error: 'Authentication required'
                });
            }

            // the actual response does not matter as long as it's 2xx range
            res.json({
                user: req.username,
                time
            });

            next();
        });

        // Example handler for bounce notifications. You should probably override it
        // with the config.plugins['core/http-bounce'].url option and send the bounce notification to somewhere else
        this.server.post('/report-bounce', (req, res, next) => {
            res.send(202, req.params.id);
            lastBounces.push({
                id: req.params.id,
                to: req.params.to,
                returnPath: req.params.returnPath,
                seq: req.params.seq,
                category: req.params.category,
                time: req.params.time,
                response: req.params.response,
                fbl: req.params.fbl
            });
            if (lastBounces.length > 150) {
                lastBounces.splice(100);
            }
            return next();
        });

        // Information about last bounces reported to the example handler
        this.server.get('/bounces', (req, res, next) => {
            res.json(200, {
                bounces: lastBounces
            });
            return next();
        });

        // POST message = Nodemailer mail structure
        this.server.post('/send', (req, res, next) => {
            if (!config.api.maildrop) {
                res.json(404, {
                    error: 'Requested service not found'
                });
                return next();
            }

            let data = req.body || {};
            data.disableFileAccess = true;
            data.disableUrlAccess = true;
            let mail = mailcomposer(data);

            let envelope = mail.getEnvelope();
            envelope.interface = 'api';
            envelope.origin = req.header('X-Originating-IP', false);
            envelope.transtype = 'HTTP';
            envelope.time = Date.now();
            envelope.user = req.header('X-Authenticated-User', false);

            let session = {
                remoteAddress: req.connection.remoteAddress,
                transmissionType: 'HTTP',
                user: envelope.user
            };

            plugins.handler.runHooks('api:mail', [envelope, session], err => {
                if (err) {
                    res.json(500, {
                        error: err.message
                    });
                    return next();
                }
                this.maildrop.add(envelope, mail.createReadStream(), (err, message) => {
                    if (err) {
                        if (err.name === 'SMTPResponse') {
                            return res.json(200, {
                                message: err.message
                            });
                        }
                        res.json(500, {
                            error: err.message
                        });
                    } else {
                        res.json(200, {
                            message
                        });
                    }
                    next();
                });
            });

        });

        // Example configuration handler that checks if an user
        // is allowed to send mail using provided MAIL FROM address
        this.server.post('/get-config', (req, res, next) => {
            let from = (req.params.from || '').trim();
            let user = req.params.user || '';

            let response = {};

            let domainName = from.split('@').pop().trim().toLowerCase();
            switch (domainName) {
                case 'example.com':
                    if (!user) {
                        response.error = 'Authentication required for kreata.ee';
                        response.code = 503;
                        res.json(200, response);
                        return next();
                    } else {
                        response.rewriteFrom = user.split('@').shift() + '@kreata.ee';
                    }
                    break;
                case 'blurdybloop.com':
                    if (req.params.transport !== 'SMTP') {
                        response.error = 'Only SMTP access allowed for nodemailer.com users';
                        response.code = 503;
                        res.json(200, response);
                        return next();
                    }
                    response.rewriteFrom = 'andris@kreata.ee';
                    break;
            }

            // load from example keys
            if (dkimKeys.has(domainName)) {
                response.dkim = {
                    keys: dkimKeys.get(domainName)
                };
            }

            res.json(200, response);
            next();
        });

        // general information about some zone
        this.server.get('/counter/:type/:key', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }

            this.queue.count(req.params.type, req.params.key, 'total', (err, total) => {
                if (err) {
                    res.json(500, {
                        error: err.message
                    });
                    return next();
                }
                this.queue.count(req.params.type, req.params.key, 'deferred', (err, deferred) => {
                    if (err) {
                        res.json(500, {
                            error: err.message
                        });
                        return next();
                    }
                    res.json({
                        [req.params.type]: req.params.key || 'all',
                        total,
                        deferred
                    });
                    next();
                });
            });
        });

        // Streams message contents
        this.server.get('/fetch/:id', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }
            this.queue.messageExists(req.params.id, (err, exists) => {
                if (err) {
                    res.json(500, {
                        error: err.message
                    });
                    return next();
                }
                if (!exists) {
                    res.json(404, {
                        error: 'Selected message does not exist'
                    });
                    return next();
                }

                if ((req.query.body || '').toString().trim().toLowerCase() === 'yes') {
                    // stream only body
                    res.writeHead(200, {
                        'Content-Type': 'message/rfc822'
                    });
                    return this.queue.retrieve(req.params.id).pipe(res);
                }

                // find headers
                this.queue.getMeta(req.params.id, (err, meta) => {
                    if (err) {
                        res.json(500, {
                            error: err.message
                        });
                        return next();
                    }

                    if (!meta || !meta.headers) {
                        res.json(404, {
                            error: 'Message not found'
                        });
                        return next();
                    }

                    let headers = new Headers(meta.headers);
                    res.writeHead(200, {
                        'Content-Type': 'message/rfc822'
                    });
                    res.write(headers.build());
                    return this.queue.retrieve(req.params.id).pipe(res);
                });
            });
        });

        // Returns message info in queue
        this.server.get('/message/:id', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }
            this.queue.getInfo(req.params.id, (err, info) => {
                if (err) {
                    res.json(500, {
                        error: err.message
                    });
                    return next();
                }
                if (!info) {
                    res.json(404, {
                        error: 'Selected message does not exist'
                    });
                    return next();
                }

                res.json(200, info);
                return next();
            });
        });

        // Returns message info in queue
        this.server.get('/internals', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }

            res.setHeader('content-type', 'text/plain; charset=utf-8');

            let iterators = [];
            this.queue.iterators.forEach((iterator, name) => {
                iterators.push({
                    name,
                    itemCount: iterator.iterator && iterator.iterator.itemCount
                });
            });

            res.send(util.inspect({
                iterators,

                defaultTtl: this.queue.locks.defaultTtl = 10 * 60 * 1000,
                locks: this.queue.locks.locks,
                zones: this.queue.locks.zones,
                lockOwners: this.queue.locks.lockOwners,
                nextTtlCheck: this.queue.locks.nextTtlCheck

            }, false, 22));

            return next();
        });
    }
}

module.exports = APIServer;
