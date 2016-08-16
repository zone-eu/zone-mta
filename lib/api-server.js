'use strict';

const config = require('config');
const log = require('npmlog');
const restify = require('restify');
const createHeaders = require('./headers');

class APIServer {
    constructor() {
        this.queue = false;
        this.closing = false;
        this.createServer();
    }

    createServer() {
        this.server = restify.createServer();
        this.server.use(restify.bodyParser({
            mapParams: true
        }));
        this.server.use(restify.queryParser());

        this.server.use(restify.authorizationParser());

        this.server.pre((request, response, next) => {
            log.verbose('HTTP', request.url);
            next();
        });

        this.setupRoutes();
    }

    start(callback) {
        let returned = false;
        this.server.on('error', err => {
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

        // test authentication example
        this.server.get('/test-auth', (req, res, next) => {
            let time = new Date().toISOString();

            if (req.username !== config.feeder.user || req.authorization.basic.password !== config.feeder.pass) {
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
                /*
                zone: 'default',
                dkim: {
                    key: '--- BEGIN PRIVATE KEY ...',
                    domain: 'kreata.ee',
                    selector: 'test'
                },
                */
                time
            });

            next();
        });

        // general information about some zone
        this.server.get('/queue/:zone', (req, res, next) => {
            if (!this.queue) {
                res.json(500, {
                    error: 'Service not yet started'
                });
                return next();
            }

            let time = new Date().toISOString();
            let queued = 0;
            let deferred = 0;
            let domains = [];
            let processed = 0;
            let started = time;
            let stats = this.queue.stats.zoneQueued.get(req.params.zone);
            if (stats) {
                queued = stats.queued;
                deferred = stats.deferred;
                processed = stats.processed;
                started = new Date(stats.started).toISOString();
                if (stats.domains) {
                    stats.domains.forEach((data, domain) => {
                        domains.push({
                            domain,
                            queued: data.queued,
                            deferred: data.deferred
                        });
                    });
                }
            }
            res.json({
                time,
                started,
                processed,
                queued,
                deferred,
                domains
            });
            next();
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

                    let headers = createHeaders(meta.headers);
                    res.writeHead(200, {
                        'Content-Type': 'message/rfc822'
                    });
                    res.write(headers.build());
                    return this.queue.retrieve(req.params.id).pipe(res);
                });
            });
        });
    }
}

module.exports = options => new APIServer(options);
