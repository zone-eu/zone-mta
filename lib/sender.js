'use strict';

const config = require('config');
const log = require('npmlog');
const os = require('os');
const fetch = require('nodemailer-fetch');
const iptools = require('./iptools');
const bounces = require('./bounces');
const Headers = require('mailsplit').Headers;
const SMTPConnection = require('smtp-connection');
const net = require('net');
const tls = require('tls');
const PassThrough = require('stream').PassThrough;
const dkimSign = require('./dkim-sign');
const EventEmitter = require('events');
const plugins = require('./plugins');
const util = require('util');

class Sender extends EventEmitter {

    constructor(clientId, connectionId, zone, sendCommand) {
        super();

        this.clientId = clientId;
        this.connectionId = connectionId;

        this.zone = zone;

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
        this.sendNext();
    }

    close() {
        this.closing = true;
    }

    sendNext() {
        if (this.closing) {
            return;
        }
        let returned = false;
        let continueSending = () => {
            if (returned) {
                return;
            }
            setImmediate(() => this.sendNext());
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
                return setTimeout(() => continueSending(), Math.min(Math.pow(this.emptyChecks, 2), 1000) * 10);
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
                    this.handleResponseError(delivery, false, err, () => false);
                    return setImmediate(() => continueSending());
                }

                this.zone.speedometer(this.ref, () => { // check throttling speed
                    let responseSent = false;
                    let handleError = (delivery, connection, err) => {
                        if (responseSent) {
                            return;
                        }
                        responseSent = true;
                        this.handleResponseError(delivery, connection, err, () => false);
                        return setImmediate(() => continueSending());
                    };

                    let connectTimer = setTimeout(() => {
                        // if we hit the timer then in most cases we are probably behind a firewall and
                        // can't connect, so just move forward and let the pending connection to either
                        // deliver the message or just expire
                        continueSending();
                    }, 10 * 1000);
                    connectTimer.unref();

                    // Try to connect to the recipient MX
                    this.getConnectionWithCache(delivery, (err, connection) => {
                        clearTimeout(connectTimer);
                        let recivedHeader;
                        if (err) {
                            // ensure that we have a received header set
                            let recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, os.hostname()));
                            delivery.headers.addFormatted('Received', recivedHeader, 0);
                            return handleError(delivery, connection, err);
                        }

                        log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s CONNECTED mx=%s[%s]', delivery.id, delivery.seq, connection.options.servername, connection.options.host);

                        let connectionDone = false;

                        connection.removeAllListeners('error');
                        connection.once('error', err => {
                            connectionDone = true;
                            connection.close();
                            return handleError(delivery, connection, err);
                        });

                        connection.removeAllListeners('end');
                        connection.once('end', () => {
                            if (connectionDone) {
                                return;
                            }
                            setTimeout(() => {
                                if (connectionDone) {
                                    return;
                                }
                                // connection reached unexpected close event
                                let host = connection && connection.options && (connection.options.servername || connection.options.host) || delivery.domain;
                                let err = new Error('Connection to ' + host + ' closed unexpectedly');
                                err.response = '450 Connection to ' + host + ' closed unexpectedly';
                                err.category = 'network';
                                return handleError(delivery, connection, err);
                            }, 1000);
                        });

                        recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, connection.options.name));
                        delivery.headers.addFormatted('Received', recivedHeader, 0);

                        plugins.handler.runHooks('sender:headers', [delivery], err => {
                            if (err) {
                                connection.close();
                                return handleError(delivery, connection, err);
                            }

                            if (config.dkim.enabled) {
                                // tro to sign the message, this would prepend a DKIM-Signature header to the message
                                this.signMessage(delivery);
                            }

                            let messageHeaders = delivery.headers.build();
                            let messageSize = recivedHeader.length + messageHeaders.length + delivery.bodySize; // required for SIZE argument
                            let messageFetch = fetch('http://' + config.api.hostname + ':' + config.api.port + '/fetch/' + delivery.id + '?body=yes');
                            let messageStream = new PassThrough();

                            messageStream.write(messageHeaders);
                            messageFetch.pipe(messageStream);
                            messageFetch.once('error', err => messageStream.emit('error', err));

                            log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s SENDING (from=%s to=%s size=%s)', delivery.id, delivery.seq, delivery.envelope.from, delivery.envelope.to, messageSize);

                            // Do the actual delivery
                            connection.send({
                                from: delivery.envelope.from,
                                to: [].concat(delivery.envelope.to || []),
                                size: messageSize
                            }, messageStream, (err, info) => {
                                connectionDone = true;
                                // kill this connection, we don't need it anymore
                                connection.close();

                                if (err) {
                                    messageStream = null;
                                    messageFetch = null;
                                    return handleError(delivery, connection, err);
                                }

                                log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s ACCEPTED from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection.options.servername || delivery.domain, this.formatSMTPResponse(info.response));

                                delivery.status = {
                                    delivered: true,
                                    mx: connection.options.servername || delivery.domain,
                                    response: this.formatSMTPResponse(info.response)
                                };

                                this.releaseDelivery(delivery, (err, released) => {
                                    if (err) {
                                        log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s Can\'t get message acknowledged. %s', delivery.id, delivery.seq, err.message);

                                        this.closing = true;
                                        return this.emit('error', err);
                                    }

                                    if (!released) {
                                        log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s NOTOFUND Failed to release delivery', delivery.id, delivery.seq);
                                    }
                                });

                                return setImmediate(() => continueSending());
                            });
                        });
                    });
                });
            });
        });
    }

    handleResponseError(delivery, connection, err, callback) {
        let maxDeferred = 6;
        let bounce = bounces.check(err.response, err.category);
        let deferredCount = delivery._deferred && delivery._deferred.count || 0;
        let smtpResponse = this.formatSMTPResponse(err.response || err.message);
        let smtpLog = connection && connection.logtrail;

        if (bounce.action !== 'reject' && deferredCount < maxDeferred) {
            let ttl = Math.min(Math.pow(5, deferredCount + 1), 1024) * 60 * 1000;

            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s DEFERRED[%s] from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, bounce.category, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection && connection.options.servername || delivery.domain, smtpResponse);

            return this.deferDelivery(delivery, ttl, smtpLog, smtpResponse, (err, deferred) => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s %s', delivery.id, delivery.seq, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }
                if (!deferred) {
                    log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s NOTOFUND Failed to defer delivery', delivery.id, delivery.seq);
                }
                return callback();
            });
        } else {
            log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s REJECTED[%s] from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, bounce.category, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection && connection.options.servername || delivery.domain, smtpResponse);

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
                    log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s NOTOFUND Failed to release delivery', delivery.id, delivery.seq);
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

                    if (err.lastErr && err.lastErr.errno === 'ETIMEDOUT') {
                        // most probably a firewall issue or a server that does not have MX running
                        // auto defer all messages to this domain for the next hour
                        ttl = 1 * 60 * 60 * 1000;
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
                        let zoneAddress = this.zone.getAddress(delivery, net.isIPv6(ip));

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

                        log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s RESOLVED MX for %s as %s[%s]. Using %s (%s[%s]) to connect', delivery.id, delivery.seq, domain, exchange.exchange, ip, this.zone.name, zoneAddress.name, zoneAddress.address);

                        let logtrail = [];
                        let logger = function (level, ...args) {
                            logtrail.push({
                                time: Date.now(),
                                level,
                                message: util.format(...args)
                            });
                        };

                        let options = {
                            servername: exchange.exchange,
                            host: ip,

                            port: this.zone.port,
                            localAddress: zoneAddress.address,
                            name: zoneAddress.name,

                            //requireTLS: !this.tlsDisabled.has(ip),
                            ignoreTLS: this.tlsDisabled.has(ip),

                            opportunisticTLS: true,
                            secure: !!this.zone.secure,
                            authMethod: this.zone.authMethod,

                            //connectionTimeout: 15 * 1000,
                            //greetingTimeout: 15 * 1000,

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
                            let returned = false;
                            let connected = false;

                            let _onError = err => {
                                connection.connected = false;
                                if (returned) {
                                    return;
                                }
                                returned = true;
                                if ((err.code === 'ETLS' || /SSL23_GET_SERVER_HELLO|\/deps\/openssl/.test(err.message)) && !this.tlsDisabled.has(ip)) {
                                    // STARTTLS failed, try again, this time without encryption
                                    log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext', delivery.id, delivery.seq, exchange.exchange, ip);
                                    this.tlsDisabled.add(ip);
                                    return tryConnectIP(err, true);
                                }
                                if (!connected) {
                                    // try next host
                                    if (mxTry >= exchanges.length) {
                                        log.info('Sender/' + this.zone.name + '/' + process.pid, '%s.%s ERRCONNECT %s[%s] for %s from %s (%s[%s]). "%s"', delivery.id, delivery.seq, exchange.exchange, ip, domain, this.zone.name, zoneAddress.name, zoneAddress.address, err.message);
                                    }
                                    return tryConnectIP(err);
                                }

                                log.error('Sender/' + this.zone.name + '/' + process.pid, '%s.%s Unexpected MX error. %s', delivery.id, delivery.seq, err.message);
                                return callback(err);
                            };

                            connection.once('error', _onError);

                            connection.once('end', () => {
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
                                    if (connection._socket instanceof tls.TLSSocket) {
                                        // todo: edit smtp-connection, add `upgrading` property to better detect
                                        // starttls connection errors
                                        err.code = 'ETLS';
                                    }
                                    _onError(err);
                                }, 1000);
                            });

                            log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s INITIALIZING (mx=%s mta=%s)', delivery.id, delivery.seq, options.host, options.localAddress);
                            connection.connect(() => {
                                log.verbose('Sender/' + this.zone.name + '/' + process.pid, '%s.%s INITIALIZED (mx=%s mta=%s)', delivery.id, delivery.seq, options.host, options.localAddress);
                                if (returned) {
                                    return;
                                }

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

    formatSMTPResponse(str) {
        let code = str.match(/^\d{3}[\s\-]+([\d\.]+\s*)?/);
        return ((code ? code[0] : '') + (code ? str.substr(code[0].length) : str).replace(/^\d{3}[\s\-]+([\d\.]+\s*)?/mg, ' ')).replace(/\s+/g, ' ').trim();
    }

    releaseDelivery(delivery, callback) {
        this.sendCommand({
            cmd: 'RELEASE',
            id: delivery.id,
            domain: delivery.domain,
            seq: delivery.seq,
            status: delivery.status,
            _lock: delivery._lock
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    deferDelivery(delivery, ttl, smtpLog, smtpResponse, callback) {
        this.sendCommand({
            cmd: 'DEFER',
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock,
            ttl,
            response: smtpResponse,
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
        this.sendCommand({
            cmd: 'BOUNCE',
            id: delivery.id,

            from: delivery.from,
            to: delivery.recipient,
            seq: delivery.seq,
            headers: delivery.headers.getList(),

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
