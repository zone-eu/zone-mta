'use strict';

const config = require('config');
const log = require('npmlog');
const remotelog = require('./remotelog');
const os = require('os');
const iptools = require('./iptools');
const bounces = require('./bounces');
const Headers = require('mailsplit').Headers;
const SMTPConnection = require('smtp-connection');
const net = require('net');
const tls = require('tls');
const dkimSign = require('./dkim-sign');
const StreamHash = require('./stream-hash');
const EventEmitter = require('events');
const plugins = require('./plugins');
const util = require('util');
const ByteCounter = require('./byte-counter');
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const GridFs = require('grid-fs');

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

class Sender extends EventEmitter {

    constructor(clientId, connectionId, zone, sendCommand) {
        super();

        this.clientId = clientId;
        this.connectionId = connectionId;

        this.zone = zone;

        this.deliveryTimer = false;
        this.tlsDisabled = new Set();

        this.sendCommand = (cmd, callback) => {
            if (typeof cmd === 'string') {
                cmd = {
                    cmd
                };
            }
            sendCommand(cmd, (err, data) => callback(err, data));
        };
        this.closing = false;
        this.ref = {}; // object value for WeakMap references
        this.emptyChecks = 0;

        MongoClient.connect(config.queue.mongodb, (err, database) => {
            if (err) {
                log.error('Queue', 'Could not initialize MongoDB: %s', err.message);
                return;
            }

            this.mongodb = database;
            this.gridstore = new GridFs(this.mongodb, config.queue.gfs);

            this.sendNext();
        });
    }

    close() {
        this.closing = true;
    }

    sendNext() {
        if (this.closing) {
            return;
        }

        let sendingDone = false;
        let responseSent = false;

        let continueSending = () => {
            if (sendingDone) {
                return;
            }
            sendingDone = true;
            setImmediate(() => this.sendNext());
        };

        let handleError = (delivery, connection, err) => {
            if (responseSent) {
                return;
            }
            responseSent = true;
            this.handleResponseError(delivery, connection, err, continueSending);
        };

        this.sendCommand('GET', (err, delivery) => {
            if (err) {
                this.closing = true;
                this.emit('error', err);
                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                return;
            }

            if (!delivery || !delivery.id) {
                this.emptyChecks++;
                clearTimeout(this.deliveryTimer);
                this.deliveryTimer = setTimeout(() => continueSending(), Math.min(Math.pow(this.emptyChecks, 2), 1000) * 10);
                return;
            }
            this.emptyChecks = 0;

            delivery.headers = new Headers(delivery.headers);

            delivery.envelope = {
                from: delivery.from,
                to: delivery.recipient
            };

            delivery.dnsOptions = {};
            ['blockDomains', 'preferIPv6', 'ignoreIPv6', 'blockLocalAddresses'].forEach(key => {
                if (key in this.zone) {
                    delivery.dnsOptions[key] = this.zone[key];
                } else if (key in config.dns) {
                    delivery.dnsOptions[key] = config.dns[key];
                }
            });

            log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s FETCHED for delivery (from=%s to=%s)', delivery.id, delivery.seq, delivery.from, delivery.recipient);

            plugins.handler.runHooks('sender:fetch', [delivery], err => {
                if (err) {
                    return handleError(delivery, false, err);
                }

                this.zone.speedometer(this.ref, () => { // check throttling speed
                    let connectTimer = setTimeout(() => {
                        // if we hit the timer then in most cases we are probably behind a firewall and
                        // can't connect, so just move forward and let the pending connection to either
                        // deliver the message or just expire
                        continueSending();
                    }, 10 * 1000);
                    connectTimer.unref();

                    let messageStream = new ByteCounter();

                    // Try to connect to the recipient MX
                    this.getConnectionWithCache(delivery, (err, connection) => {
                        clearTimeout(connectTimer);

                        // prepare received header, we need this when sending out the message or when sending a bounce with
                        // message headers contained. we do not modify the stored delivery object, only the current instance in memory
                        let recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, connection && connection.options.name || os.hostname()));
                        delivery.headers.addFormatted('Received', recivedHeader, 0);

                        if (err) {
                            return handleError(delivery, connection, err);
                        }

                        log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s [%s] CONNECTED mx=%s[%s]', delivery.id, delivery.seq, connection.id, connection.options.servername, connection.options.host);

                        // set to true once we have sent a message or something fails
                        let connectionDone = false;
                        // clear existing handlers
                        connection.removeAllListeners('error');
                        connection.removeAllListeners('end');

                        connection.once('error', err => {
                            log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s CONNECTION [%s] %s', delivery.id, delivery.seq, connection.id, err.message);

                            connection.close(); // just in case the connection is not closed
                            if (connectionDone) {
                                return;
                            }
                            connectionDone = true;
                            return handleError(delivery, connection, err);
                        });

                        connection.once('end', () => {
                            log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s CLOSED [%s]', delivery.id, delivery.seq, connection.id);

                            if (connectionDone) {
                                return;
                            }
                            // connection was closed but we might have a race condition, so wait a bit before declaring connection close as unexpected
                            setTimeout(() => {
                                if (connectionDone) {
                                    return;
                                }
                                connectionDone = true;

                                // connection reached unexpected close event
                                let host = connection && connection.options && (connection.options.servername || connection.options.host) || delivery.domain;
                                let err = new Error('Connection to ' + host + ' closed unexpectedly');
                                err.response = '450 Connection to ' + host + ' closed unexpectedly';
                                err.category = 'network';
                                return handleError(delivery, connection, err);
                            }, 1000).unref();
                        });

                        plugins.handler.runHooks('sender:headers', [delivery, connection], err => {
                            if (err) {
                                connectionDone = true;
                                connection.close();
                                return handleError(delivery, connection, err);
                            }

                            if (config.dkim.enabled) {
                                // tro to sign the message, this would prepend a DKIM-Signature header to the message
                                this.signMessage(delivery);
                            }

                            let messageHeaders = delivery.headers.build();
                            let messageSize = recivedHeader.length + messageHeaders.length + delivery.bodySize; // required for SIZE argument
                            let messageFetch = this.gridstore.createReadStream('message ' + delivery.id);
                            let messageHash = new StreamHash({
                                algo: 'md5'
                            });

                            messageStream.write(messageHeaders);
                            messageFetch.pipe(messageHash).pipe(messageStream);
                            messageFetch.once('error', err => {
                                if (messageStream) {
                                    log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s FETCHFAIL [%s] fetch: %s', delivery.id, delivery.seq, connection.id, JSON.stringify(String(err.stack)));
                                    messageStream.emit('error', err);
                                } else {
                                    log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s UNEXPECTED fetchfail [%s] fetch: %s', delivery.id, delivery.seq, connection.id, JSON.stringify(String(err.stack)));
                                }
                            });
                            messageHash.once('hash', data => {
                                delivery.sentBodyHash = data.hash;
                                delivery.sentBodySize = data.bytes;
                                delivery.md5Match = delivery.sourceMd5 === data.hash;
                            });

                            log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SENDING [%s] (from=%s to=%s size=%s)', delivery.id, delivery.seq, connection.id, delivery.envelope.from, delivery.envelope.to, messageSize);

                            // Do the actual delivery
                            connection.send({
                                from: delivery.envelope.from,
                                to: [].concat(delivery.envelope.to || []),
                                size: messageSize
                            }, messageStream, (err, info) => {

                                if (messageFetch.readable) {
                                    let input = messageFetch;
                                    let readsize = 0;
                                    input.on('readable', () => {
                                        let chunk;
                                        while ((chunk = input.read()) !== null) {
                                            readsize += chunk.length;
                                        }
                                    });
                                    input.once('end', () => {
                                        input = null;
                                        log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s UNCLOSED [%s] Socket was not closed readsize=%s', delivery.id, delivery.seq, connection.id, readsize);
                                    });
                                }

                                if (!err && info && connectionDone) {
                                    // message seems to be sent but connection is already ended
                                    log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s UNEXPECTED [%s] message delivery: %s', delivery.id, delivery.seq, connection.id, JSON.stringify(info));
                                }

                                // ignore any future events regarding this connection
                                connectionDone = true;

                                // kill this connection, we don't need it anymore
                                if (!err) {
                                    connection.quit();
                                }
                                setImmediate(() => connection.close());

                                let messageStats = messageStream.stats();

                                if (err) {
                                    messageStream = null;
                                    messageFetch = null;
                                    err.messageStats = messageStats;
                                    return handleError(delivery, connection, err);
                                }

                                log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s ACCEPTED from=%s[%s] to=%s mx=%s body=%s md5=%s[%s] (%s)', delivery.id, delivery.seq, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection.options.servername || delivery.domain, delivery.sentBodySize || -1, (delivery.sentBodyHash || '?').substr(0, 12), delivery.md5Match ? 'MD5_OK' : 'MD5_FAIL', bounces.formatSMTPResponse(info.response));

                                remotelog(delivery.id, delivery.seq, 'ACCEPTED', {
                                    zone: this.zone.name,
                                    from: delivery.from,
                                    returnPath: delivery.envelope && delivery.envelope.from || delivery.from,
                                    to: delivery.envelope && delivery.envelope.to || delivery.recipient,
                                    mx: connection.options.servername || delivery.domain,
                                    host: connection.options.host,
                                    ip: connection.options.localAddress,
                                    response: bounces.formatSMTPResponse(info.response).substr(0, 192),
                                    size: messageStats.size,
                                    timer: messageStats.time,
                                    start: messageStats.start
                                });

                                delivery.status = {
                                    delivered: true,
                                    mx: connection.options.servername || delivery.domain,
                                    response: bounces.formatSMTPResponse(info.response)
                                };

                                this.releaseDelivery(delivery, (err, released) => {
                                    if (err) {
                                        log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s Can\'t get message acknowledged. %s', delivery.id, delivery.seq, err.message);

                                        this.closing = true;
                                        return this.emit('error', err);
                                    }

                                    if (!released) {
                                        log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s NOTFOUND Failed to release delivery', delivery.id, delivery.seq);
                                    }

                                    return setImmediate(() => continueSending());
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    handleResponseError(delivery, connection, err, callback) {
        let bounce;

        if (!err.responseCode && !/^\d{3}\b/.test(err.response || err.message)) {
            // timeouts, node network errors etc.
            bounce = {
                action: 'defer',
                category: 'connection',
                message: err.response || err.message,
                code: 488,
                status: false
            };
        } else {
            bounce = bounces.check(err.response, err.category);
        }

        bounce.action = err.action || bounce.action;

        let deferredCount = delivery._deferred && delivery._deferred.count || 0;
        let smtpResponse = bounces.formatSMTPResponse(err.response || err.message);
        let smtpLog = connection && connection.logtrail || err.logtrail;

        if (bounce.action !== 'reject' && deferredCount < ttlMinutes.length) {
            //let ttl = Math.min(Math.pow(5, Math.min(deferredCount + 1, 4)), 180) * 60 * 1000;
            let ttl = ttlMinutes[deferredCount] * 60 * 1000;

            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s DEFERRED[%s] from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, bounce.category, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection && connection.options.servername || delivery.domain, smtpResponse);

            remotelog(delivery.id, delivery.seq, 'DEFERRED', {
                category: bounce.category,
                defcount: deferredCount + 1,
                nextattempt: Date.now() + ttl,
                zone: this.zone.name,
                from: delivery.from,
                returnPath: delivery.envelope && delivery.envelope.from || delivery.from,
                to: delivery.envelope && delivery.envelope.to || delivery.recipient,
                mx: connection && connection.options.servername || delivery.domain,
                host: connection && connection.options.host,
                ip: connection && connection.options.localAddress,
                response: smtpResponse.substr(0, 192),
                size: err.messageStats && err.messageStats.size,
                timer: err.messageStats && err.messageStats.time,
                start: err.messageStats && err.messageStats.start
            });

            return this.deferDelivery(delivery, ttl, smtpLog, smtpResponse, bounce, (err, deferred) => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s %s', delivery.id, delivery.seq, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }
                if (!deferred) {
                    log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s NOTFOUND Failed to defer delivery', delivery.id, delivery.seq);
                }
                return callback();
            });
        } else {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s REJECTED[%s] from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, bounce.category, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection && connection.options.servername || delivery.domain, smtpResponse);

            remotelog(delivery.id, delivery.seq, 'REJECTED', {
                category: bounce.category,
                zone: this.zone.name,
                from: delivery.from,
                returnPath: delivery.envelope && delivery.envelope.from || delivery.from,
                to: delivery.envelope && delivery.envelope.to || delivery.recipient,
                mx: connection && connection.options.servername || delivery.domain,
                host: connection && connection.options.host,
                ip: connection && connection.options.localAddress,
                response: smtpResponse.substr(0, 192),
                size: err.messageStats && err.messageStats.size,
                timer: err.messageStats && err.messageStats.time,
                start: err.messageStats && err.messageStats.start
            });

            delivery.status = {
                delivered: false,
                mx: connection && connection.options.servername || delivery.domain,
                response: smtpResponse
            };

            return this.releaseDelivery(delivery, (err, released) => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s %s', delivery.id, delivery.seq, err.message);
                    this.closing = true;
                    return this.emit('error', err);
                }

                if (released) {
                    setImmediate(() => this.sendBounceMessage(delivery, bounce, smtpResponse));
                } else {
                    log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s NOTFOUND Failed to release delivery', delivery.id, delivery.seq);
                }

                return callback();
            });
        }
    }

    getConnectionWithCache(delivery, callback) {
        let cacheKey = 'domain:' + delivery.domain;
        this.sendCommand({
            cmd: 'GETCACHE',
            key: this.zone.name + ':' + cacheKey
        }, (err, domainData) => {
            if (err) {
                return callback(err);
            }

            if (domainData && domainData.error) {
                let err = new Error(domainData.error);
                err.response = domainData.response;
                err.category = domainData.category;
                err.action = 'defer';
                return callback(err);
            }

            this.getConnection(delivery, (err, connection) => {

                let cmd;
                if (err) {
                    let ttl;
                    let domainData = {};

                    // if we were not able to successfully connect to a server then store error result
                    domainData.error = err.message;
                    domainData.response = err.response;
                    domainData.category = err.category;

                    if (err.lastErr && [err.lastErr.errno, err.lastErr.code].includes('ETIMEDOUT')) {
                        // most probably a firewall issue or a server that does not have MX running
                        ttl = 15 * 60 * 1000;
                    } else {
                        // auto defer all messages to this server for the next 10 minutes
                        ttl = 10 * 60 * 1000;
                    }
                    cmd = {
                        cmd: 'SETCACHE',
                        key: this.zone.name + ':' + cacheKey,
                        value: domainData,
                        ttl
                    };
                } else {
                    // if the server was blocked then this update would release it
                    cmd = {
                        cmd: 'CLEARCACHE',
                        key: this.zone.name + ':' + cacheKey
                    };
                }

                setImmediate(() => callback(err, connection));

                this.sendCommand(cmd, () => false);
            });
        });
    }

    getConnection(delivery, connectionCallback) {
        let domain = delivery.domain;
        let blockDomains = delivery.dnsOptions.blockDomains;
        if (!Array.isArray(blockDomains)) {
            blockDomains = [].concat(blockDomains || []);
        }

        // protect against multiple errors from the connections
        let callbackDone = false;
        let callback = (err, connection) => {
            if (callbackDone) {
                return;
            }
            callbackDone = true;
            connectionCallback(err, connection);
        };

        let resolveMx = (domain, next) => {
            if (this.zone.host) {
                return next(null, [{
                    exchange: this.zone.host,
                    priority: 0
                }]);
            }

            let exchanges = [];
            plugins.handler.runHooks('sender:mx', [delivery, exchanges], err => {
                if (err) {
                    return next(err);
                }

                if (exchanges && exchanges.length) {
                    return next(null, exchanges);
                }

                iptools.resolveMx(domain, delivery.dnsOptions, next);
            });
        };

        resolveMx(domain, (err, exchanges) => {
            if (err) {
                return callback(err);
            }

            if (!exchanges) {
                // try again later (4xx code defers, 5xx rejects) just in case the recipients DNS is down
                err = err || new Error('Can\'t find an MX server for ' + domain);
                err.response = '450 Can\'t find an MX server for ' + domain;
                err.category = 'dns';
                return callback(err);
            }

            let mxTry = 0;

            let tryConnectMX = lastErr => {
                if (mxTry >= exchanges.length) {
                    let err = new Error('Can\'t connect to MX');
                    if (lastErr) {
                        err.lastErr = lastErr;
                    }
                    err.response = lastErr && lastErr.response || ('450 Can\'t connect to any MX server for ' + domain);
                    err.category = lastErr && lastErr.category || 'network';
                    err.logtrail = lastErr && lastErr.logtrail || 'network';
                    return callback(err);
                }
                let exchange = exchanges[mxTry++];

                // check if exchange is not blocked
                if (blockDomains.includes(exchange.exchange)) {
                    let err = new Error('Blocked MX hostname ' + exchange.exchange);
                    if (mxTry >= exchanges.length) {
                        err.response = '550 Can\'t connect to the MX server ' + exchange.exchange + ' for ' + domain;
                        err.category = 'dns';
                        return callback(err);
                    }
                    return tryConnectMX(err);
                }

                iptools.resolveIp(exchange.exchange, delivery.dnsOptions, (err, ipList) => {
                    if (err) {
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, '%s.%s Error resolving A/AAAA for %s. %s', delivery.id, delivery.seq, exchange.exchange, err.message);
                        return tryConnectMX(err);
                    }
                    if (!ipList.length) {
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, '%s.%s Could not resolve A/AAAA for %s', delivery.id, delivery.seq, exchange.exchange);
                        return tryConnectMX(lastErr);
                    }

                    let ipTry = -1;
                    let tryConnectIP = (lastErr, retryConnection) => {
                        if (!retryConnection && ipTry >= ipList.length - 1) {
                            return tryConnectMX(lastErr);
                        }
                        let ip = retryConnection ? ipList[ipTry] : ipList[++ipTry];
                        delivery.zoneAddress = this.zone.getAddress(delivery, net.isIPv6(ip), delivery.disabledAddresses);

                        // check if exchange is not blocked
                        if (blockDomains.includes(ip)) {
                            let err = new Error('Blocked MX host ' + ip);
                            err.response = '550 Can\'t connect to the MX server ' + ip + ' for ' + domain;
                            err.category = 'dns';
                            return tryConnectIP(err);
                        }

                        if (delivery.dnsOptions.blockLocalAddresses) {
                            // check if exchange is not blocked
                            if (iptools.isLocal(ip)) {
                                let err = new Error('Blocked local MX host ' + ip);
                                err.response = '550 Can\'t connect to the MX server ' + ip + ' for ' + domain;
                                err.category = 'dns';
                                return tryConnectIP(err);
                            }
                            let invalidRange = iptools.isInvalid(ip);
                            if (invalidRange) {
                                let err = new Error('Blocked MX host ' + ip + ' for invalid IP range ' + invalidRange);
                                err.response = '550 Can\'t connect to the MX server ' + ip + ' in ' + invalidRange + ' network for ' + domain;
                                err.category = 'dns';
                                return tryConnectIP(err);
                            }
                        }

                        log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s RESOLVED MX for %s as %s[%s]. Using %s (%s[%s]) to connect', delivery.id, delivery.seq, domain, exchange.exchange, ip, this.zone.name, delivery.zoneAddress.name, delivery.zoneAddress.address);

                        let logtrail = [];
                        let that = this;
                        let logger = function (level, ...args) {
                            logtrail.push({
                                time: Date.now(),
                                level,
                                message: util.format(...args)
                            });
                            if (delivery.logger) {
                                util.format(...args).split('\n').forEach(line => {
                                    log.info('Sender/' + that.zone.name + '/' + process.pid, '%s.%s SMTP %s: %s', delivery.id, delivery.seq, level, line);
                                });
                            }
                        };

                        let options = {
                            servername: exchange.exchange,
                            host: ip,

                            port: this.zone.port,
                            localAddress: delivery.zoneAddress.address,
                            name: delivery.zoneAddress.name,

                            //requireTLS: !this.tlsDisabled.has(ip),
                            ignoreTLS: this.tlsDisabled.has(ip),

                            opportunisticTLS: true,
                            secure: !!this.zone.secure,
                            authMethod: this.zone.authMethod,

                            connectionTimeout: 5 * 60 * 1000,
                            greetingTimeout: 2 * 60 * 1000,

                            tls: {
                                servername: exchange.exchange,
                                rejectUnauthorized: false
                            },

                            transactionLog: true,
                            logger: {
                                info: logger.bind(null, 'INF'),
                                debug: logger.bind(null, 'DBG'),
                                error: logger.bind(null, 'ERR')
                            },
                            debug: ('debug' in this.zone ? this.zone.debug : config.log.queue)
                        };

                        plugins.handler.runHooks('sender:connect', [delivery, options], err => {
                            if (err) {
                                return tryConnectIP(err);
                            }

                            let connection = new SMTPConnection(options);
                            connection.logtrail = logtrail;
                            let connId = connection.id;
                            let returned = false;
                            let connected = false;

                            let _onError = err => {
                                connection.connected = false;
                                if (returned) {
                                    return;
                                }
                                returned = true;

                                err.response = err.response || '450 Error connecting to ' + ip + '. ' + err.message;
                                err.category = err.category || 'network';
                                err.logtrail = logtrail;

                                if ((err.code === 'ETLS' || /SSL23_GET_SERVER_HELLO|\/deps\/openssl/.test(err.message) || err.code === 'ECONNRESET') && !this.tlsDisabled.has(ip)) {
                                    // STARTTLS failed, try again, this time without encryption
                                    log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s ERRCONNECT [%s] Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext', delivery.id, delivery.seq, connId, exchange.exchange, ip);
                                    plugins.handler.runHooks('sender:tlserror', [options, err], () => false);
                                    this.tlsDisabled.add(ip);
                                    return tryConnectIP(err, true);
                                }
                                if (!connected) {
                                    // try next host
                                    if (mxTry >= exchanges.length) {
                                        log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s ERRCONNECT [%s] %s[%s] for %s from %s (%s[%s]). "%s"', delivery.id, delivery.seq, connId, exchange.exchange, ip, domain, this.zone.name, delivery.zoneAddress.name, delivery.zoneAddress.address, err.message);
                                    }
                                    return tryConnectIP(err);
                                }

                                log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s ERRCONNECT [%s] Unexpected MX error. %s', delivery.id, delivery.seq, connId, err.message);
                                return callback(err);
                            };

                            connection.once('error', err => {
                                log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s CONNECTION [%s] %s', delivery.id, delivery.seq, connId, err.message);
                                _onError(err);
                            });

                            connection.once('end', () => {
                                log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s CLOSED [%s]', delivery.id, delivery.seq, connId);
                                connection.connected = false;
                                if (returned) {
                                    return;
                                }
                                setTimeout(() => {
                                    if (returned) {
                                        return;
                                    }
                                    // still have not returned, this means we have an unexpected connection close
                                    let err = new Error('Unexpected socket close');
                                    if (connection._socket instanceof tls.TLSSocket || (connection._socket && connection._socket.upgrading)) {
                                        // todo: edit smtp-connection, add `upgrading` property to better detect
                                        // starttls connection errors
                                        err.code = 'ETLS';
                                    }
                                    _onError(err);
                                }, 1000).unref();
                            });

                            log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s INITIALIZING [%s] (mx=%s mta=%s)', delivery.id, delivery.seq, connId, options.host, options.localAddress);
                            connection.connect(() => {
                                log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s INITIALIZED [%s] (mx=%s mta=%s)', delivery.id, delivery.seq, connId, options.host, options.localAddress);
                                if (returned) {
                                    return;
                                }

                                plugins.handler.runHooks('sender:connected', [connection, options, !!connection.secure], () => false);

                                let auth = next => {
                                    if (this.zone.auth) {
                                        return connection.login(this.zone.auth, next);
                                    }
                                    next();
                                };

                                auth(err => {
                                    if (returned) {
                                        return;
                                    }
                                    returned = true;
                                    if (err) {
                                        connection.close();
                                        return callback(err);
                                    }
                                    connected = true;
                                    connection.connected = true;
                                    return callback(null, connection);
                                });
                            });
                        });
                    };

                    tryConnectIP();
                });
            };

            tryConnectMX();
        });
    }

    releaseDelivery(delivery, callback) {
        this.sendCommand({
            cmd: 'RELEASE',
            id: delivery.id,
            domain: delivery.domain,
            to: delivery.recipient,
            seq: delivery.seq,
            status: delivery.status,
            address: delivery.zoneAddress && delivery.zoneAddress.address,
            _lock: delivery._lock
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    deferDelivery(delivery, ttl, smtpLog, smtpResponse, bounce, callback) {
        this.sendCommand({
            cmd: 'DEFER',
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock,
            ttl,
            response: smtpResponse,
            address: delivery.zoneAddress && delivery.zoneAddress.address,
            category: bounce.category,
            log: smtpLog
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    signMessage(delivery) {
        if (!delivery.dkim) {
            return;
        }
        [].concat(delivery.dkim.keys || []).reverse().forEach(key => {
            let dkimHeader;
            dkimHeader = dkimSign.sign(delivery.headers, delivery.dkim.hashAlgo, delivery.dkim.bodyHash, key);
            if (dkimHeader) {
                delivery.headers.addFormatted('dkim-signature', dkimHeader);
            }
        });
    }

    sendBounceMessage(delivery, bounce, smtpResponse) {
        if (/^mailer\-daemon@/i.test(delivery.from) || !delivery.from) {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SKIPBOUNCE Skip bounce to %s due to envelope (MAIL FROM=%s)', delivery.id, delivery.seq, delivery.from || '<>', JSON.stringify(delivery.from || '').replace(/"/g, '').trim() || '<>');
            return;
        }

        if (delivery.skipBounce) {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SKIPBOUNCE Skip bounce to %s as defined by routing', delivery.id, delivery.seq, delivery.from || '<>');
            return;
        }

        let xAutoResponseSuppress = delivery.headers.getFirst('X-Auto-Response-Suppress');
        if (/\ball\b/i.test(xAutoResponseSuppress)) {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SKIPBOUNCE Skip bounce to %s due to header (%s=%s)', delivery.id, delivery.seq, delivery.from || '<>', 'X-Auto-Response-Suppress', JSON.stringify(xAutoResponseSuppress).replace(/"/g, '').trim());
            return;
        }

        let autoSubmitted = delivery.headers.getFirst('Auto-Submitted');
        if (/\bauto\-(generated|replied)\b/i.test(autoSubmitted)) {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SKIPBOUNCE Skip bounce to %s due to header (%s=%s)', delivery.id, delivery.seq, delivery.from || '<>', 'Auto-Submitted', JSON.stringify(autoSubmitted).replace(/"/g, '').trim());
            return;
        }

        if (/^mailer\-daemon@/i.test(delivery.parsedEnvelope.from)) {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SKIPBOUNCE Skip bounce to %s due to header (%s=%s)', delivery.id, delivery.seq, delivery.from || '<>', 'From', JSON.stringify(delivery.parsedEnvelope.from || '<>').replace(/"/g, '').trim() || '<>');
            return;
        }

        this.sendCommand({
            cmd: 'BOUNCE',
            id: delivery.id,

            from: delivery.from,
            to: delivery.recipient,
            seq: delivery.seq,
            headers: delivery.headers.getList(),

            address: delivery.zoneAddress && delivery.zoneAddress.address,

            returnPath: delivery.from,
            category: bounce.category,
            time: Date.now(),
            response: smtpResponse,

            fbl: delivery.fbl
        }, err => {
            if (err) {
                this.close();
                this.emit('error', err);
                log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s %s', delivery.id, delivery.seq, err.message);
                return;
            }
        });
    }
}

module.exports = Sender;
