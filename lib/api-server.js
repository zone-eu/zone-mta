'use strict';

const config = require('config');
const log = require('npmlog');
const restify = require('restify');
const Headers = require('mailsplit').Headers;
const MailDrop = require('./mail-drop');
const mailcomposer = require('mailcomposer');
const fs = require('fs');
const pathlib = require('path');

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
        this.maildrop = new MailDrop(config);
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

        // Example handler for authentication. You should probably override it
        // with the config.feeder.authUrl option
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
                time
            });

            next();
        });

        // Example handler for bounce notifications. You should probably override it
        // with the config.bounces.url option
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

            envelope.origin = req.connection.remoteAddress;
            envelope.transtype = 'HTTP';
            envelope.time = Date.now();

            this.maildrop.add(false, envelope, mail.createReadStream(), (err, message) => {
                if (err) {
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

        // example configuration handler that checks if an user
        // is allowed to send mail using provided MAIL FROM address
        this.server.post('/get-config', (req, res, next) => {
            let from = (req.params.from || '').trim();
            let user = req.params.user || '';

            let response = {};
            let domainName = from.split('@').pop().trim().toLowerCase();
            if (domainName === 'kreata.ee') {
                if (!user) {
                    response.error = 'Authentication required for kreata.ee';
                    response.code = 503;
                    res.json(200, response);
                    return next();
                } else {
                    response.rewriteFrom = user.split('@').shift() + '@kreata.ee';
                }
            } else if (from.split('@').pop().trim().toLowerCase() === 'nodemailer.com') {
                response.rewriteFrom = 'andris@kreata.ee';
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

        // Example handler for rewriting HTML content. You should probably override it
        // with the config.rewrite.url option
        this.server.post('/rewrite', (req, res) => {
            let html = req.params.html;

            let infoStr = '<table>' +
                '<tr><td>Queue ID</td><td><strong>' + req.params.id + '</strong></td></tr>' +
                '<tr><td>Message-ID</td><td><strong>' + (req.params.messageId || '').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '</strong></td></tr>' +
                '<tr><td>From</td><td><strong>' + (req.params.from || '').toString() + '</strong></td></tr>' +
                '<tr><td>To</td><td><strong>' + (req.params.to || '').toString() + '</strong></td></tr>' +
                '</table>';

            if (/<\/body\b/i.test(html)) {
                // add before <body> close
                html.replace(/<\/body\b/i, match => '\r\n' + infoStr + '\r\n' + match);
            } else {
                // append to the body
                html += '\r\n' + infoStr;
            }

            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8'
            });
            res.write(html);
            res.end();
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

                    let headers = new Headers(meta.headers);
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
