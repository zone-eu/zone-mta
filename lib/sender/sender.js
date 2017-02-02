'use strict';

const config = require('config');
const log = require('npmlog');
const remotelog = require('../remotelog');
const os = require('os');
const iptools = require('../iptools');
const bounces = require('../bounces');
const Headers = require('mailsplit').Headers;
const SMTPConnection = require('smtp-connection');
const net = require('net');
const tls = require('tls');
const dkimSign = require('../dkim-sign');
const StreamHash = require('../stream-hash');
const EventEmitter = require('events');
const plugins = require('../plugins');
const util = require('util');
const ByteCounter = require('../byte-counter');
const crypto = require('crypto');

class Sender extends EventEmitter {

    constructor(clientId, zone, queue) {
        super();

        this.clientId = clientId;
        this.zone = zone;
        this.queue = queue;

        this.logName = 'Sender/' + this.zone.name + '/' + process.pid;

        this.deliveryTimer = false;
        this.tlsDisabled = new Set();
        this.closing = false;
        this.ref = {}; // object value for WeakMap references

        console.log('SETUP SENDER');
        this.queue.setupSubscriber(zone.connections, ['sender', this.zone.name, process.pid, crypto.randomBytes(4).toString('hex')].join('_'), (...args) => this.sendNext(...args));
    }

    close() {
        this.closing = true;
    }

    sendNext(delivery, response) {
        if (this.closing) {
            return;
        }

        let connectTimer = setTimeout(() => {
            // if we hit the timer then in most cases we are probably behind a firewall and
            // can't connect, so just move forward and let the pending connection to either
            // deliver the message or just expire
            response.continue();
        }, 10 * 1000);
        connectTimer.unref();

        console.log(delivery);

        let responseSent = false;
        let handleError = (delivery, connection, err) => {
            clearTimeout(connectTimer);
            if (responseSent) {
                return;
            }
            responseSent = true;
            this.handleResponseError(delivery, connection, err, () => response.ack());
        };

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

        log.verbose(this.logName, '%s.%s FETCHED for delivery (from=%s to=%s)', delivery.id, delivery.seq, delivery.from, delivery.recipient);

        plugins.handler.runHooks('sender:fetch', [delivery], err => {
            if (err) {
                return handleError(delivery, false, err);
            }

            let messageStream = new ByteCounter();

            // Try to connect to the recipient MX
            this.getConnection(delivery, (err, connection) => {

                // prepare received header, we need this when sending out the message or when sending a bounce with
                // message headers contained. we do not modify the stored delivery object, only the current instance in memory
                let recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, connection && connection.options.name || os.hostname()));
                delivery.headers.addFormatted('Received', recivedHeader, 0);

                if (err) {
                    return handleError(delivery, connection, err);
                }

                log.verbose(this.logName, '%s.%s [%s] CONNECTED mx=%s[%s]', delivery.id, delivery.seq, connection.id, connection.options.servername, connection.options.host);

                // set to true once we have sent a message or something fails
                let connectionDone = false;
                // clear existing handlers
                connection.removeAllListeners('error');
                connection.removeAllListeners('end');

                connection.once('error', err => {
                    log.error(this.logName, '%s.%s CONNECTION [%s] %s', delivery.id, delivery.seq, connection.id, err.message);

                    connection.close(); // just in case the connection is not closed
                    if (connectionDone) {
                        return;
                    }
                    connectionDone = true;
                    return handleError(delivery, connection, err);
                });

                connection.once('end', () => {
                    log.verbose(this.logName, '%s.%s CLOSED [%s]', delivery.id, delivery.seq, connection.id);

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
                    let messageFetch = this.queue.retrieve(delivery.id);
                    let messageHash = new StreamHash({
                        algo: 'md5'
                    });

                    messageStream.write(messageHeaders);
                    messageFetch.pipe(messageHash).pipe(messageStream);
                    messageFetch.once('error', err => {
                        if (messageStream) {
                            log.error(this.logName, '%s.%s FETCHFAIL [%s] error=%s', delivery.id, delivery.seq, connection.id, err.message);
                            messageStream.emit('error', err);
                        } else {
                            log.error(this.logName, '%s.%s UNEXPECTED fetchfail [%s] error=%s', delivery.id, delivery.seq, connection.id, err.message);
                        }
                    });
                    messageHash.once('hash', data => {
                        delivery.sentBodyHash = data.hash;
                        delivery.sentBodySize = data.bytes;
                        delivery.md5Match = delivery.sourceMd5 === data.hash;
                    });

                    log.verbose(this.logName, '%s.%s SENDING [%s] (from=%s to=%s size=%s)', delivery.id, delivery.seq, connection.id, delivery.envelope.from, delivery.envelope.to, messageSize);

                    // Do the actual delivery
                    connection.send({
                        from: delivery.envelope.from,
                        to: [].concat(delivery.envelope.to || []),
                        size: messageSize
                    }, messageStream, (err, info) => {
                        clearTimeout(connectTimer);

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
                                log.verbose(this.logName, '%s.%s UNCLOSED [%s] Socket was not closed readsize=%s', delivery.id, delivery.seq, connection.id, readsize);
                            });
                        }

                        if (!err && info && connectionDone) {
                            // message seems to be sent but connection is already ended
                            log.error(this.logName, '%s.%s UNEXPECTED [%s] message delivery: %s', delivery.id, delivery.seq, connection.id, JSON.stringify(info));
                        }

                        // ignore any future events regarding this connection
                        connectionDone = true;

                        // kill this connection, we don't need it anymore
                        if (!err) {
                            connection.quit();
                        }
                        setImmediate(() => connection.close());

                        if (err) {
                            messageStream = null;
                            messageFetch = null;
                            return handleError(delivery, connection, err);
                        }

                        log.info(this.logName, '%s.%s ACCEPTED from=%s[%s] to=%s mx=%s body=%s md5=%s[%s] (%s)', delivery.id, delivery.seq, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection.options.servername || delivery.domain, delivery.sentBodySize || -1, (delivery.sentBodyHash || '?').substr(0, 12), delivery.md5Match ? 'MD5_OK' : 'MD5_FAIL', bounces.formatSMTPResponse(info.response));

                        remotelog(delivery.id, delivery.seq, 'ACCEPTED', {
                            zone: this.zone.name,
                            from: delivery.from,
                            returnPath: delivery.envelope && delivery.envelope.from || delivery.from,
                            to: delivery.envelope && delivery.envelope.to || delivery.recipient,
                            mx: connection.options.servername || delivery.domain,
                            host: connection.options.host,
                            ip: connection.options.localAddress,
                            response: bounces.formatSMTPResponse(info.response).substr(0, 192)
                        });

                        return this.queue.releaseDelivery(delivery, () => response.ack());
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

        let smtpResponse = bounces.formatSMTPResponse(err.response || err.message);

        if (bounce.action !== 'reject') {
            return this.queue.deferDelivery(delivery.queueContent, smtpResponse, (err, result) => {
                if (err) {
                    log.error(this.logName, '%s.%s %s', delivery.id, delivery.seq, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }

                switch (result) {
                    case this.queue.FAILED:
                        log.info(this.logName, '%s.%s NOTFOUND Failed to defer delivery', delivery.id, delivery.seq);
                        return callback();
                    case this.queue.BOUNCED:
                        return this.rejectDelivery(delivery, bounce, connection, smtpResponse, callback);
                    default:
                        if (result !== this.queue.DEFERRED) {
                            log.info(this.logName, '%s.%s DEFERFAIL Failed to defer delivery', delivery.id, delivery.seq);
                            return callback();
                        }
                }

                log.info(this.logName, '%s.%s DEFERRED[%s] from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, bounce.category, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection && connection.options.servername || delivery.domain, smtpResponse);

                remotelog(delivery.id, delivery.seq, 'DEFERRED', {
                    category: bounce.category,
                    zone: this.zone.name,
                    from: delivery.from,
                    returnPath: delivery.envelope && delivery.envelope.from || delivery.from,
                    to: delivery.envelope && delivery.envelope.to || delivery.recipient,
                    mx: connection && connection.options.servername || delivery.domain,
                    host: connection && connection.options.host,
                    ip: connection && connection.options.localAddress,
                    response: smtpResponse.substr(0, 192)
                });

                return callback();
            });
        } else {
            this.rejectDelivery(delivery, bounce, connection, smtpResponse, callback);
        }
    }

    rejectDelivery(delivery, bounce, connection, smtpResponse, callback) {
        log.info(this.logName, '%s.%s REJECTED[%s] from=%s[%s] to=%s mx=%s (%s)', delivery.id, delivery.seq, bounce.category, delivery.from, delivery.envelope && delivery.envelope.from || delivery.from, delivery.envelope && delivery.envelope.to || delivery.recipient, connection && connection.options.servername || delivery.domain, smtpResponse);

        remotelog(delivery.id, delivery.seq, 'REJECTED', {
            category: bounce.category,
            zone: this.zone.name,
            from: delivery.from,
            returnPath: delivery.envelope && delivery.envelope.from || delivery.from,
            to: delivery.envelope && delivery.envelope.to || delivery.recipient,
            mx: connection && connection.options.servername || delivery.domain,
            host: connection && connection.options.host,
            ip: connection && connection.options.localAddress,
            response: smtpResponse.substr(0, 192)
        });

        delivery.status = {
            delivered: false,
            mx: connection && connection.options.servername || delivery.domain,
            response: smtpResponse
        };

        return this.queue.releaseDelivery(delivery, (err, released) => {
            if (err) {
                log.error(this.logName, '%s.%s %s', delivery.id, delivery.seq, err.message);
                this.closing = true;
                return this.emit('error', err);
            }

            if (released) {
                setImmediate(() => this.sendBounceMessage(delivery, bounce, smtpResponse));
            } else {
                log.info(this.logName, '%s.%s NOTFOUND Failed to release delivery', delivery.id, delivery.seq);
            }

            return callback();
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
                        log.silly(this.logName, '%s.%s Error resolving A/AAAA for %s. %s', delivery.id, delivery.seq, exchange.exchange, err.message);
                        return tryConnectMX(err);
                    }
                    if (!ipList.length) {
                        log.silly(this.logName, '%s.%s Could not resolve A/AAAA for %s', delivery.id, delivery.seq, exchange.exchange);
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

                        log.info(this.logName, '%s.%s RESOLVED MX for %s as %s[%s]. Using %s (%s[%s]) to connect', delivery.id, delivery.seq, domain, exchange.exchange, ip, this.zone.name, delivery.zoneAddress.name, delivery.zoneAddress.address);

                        let that = this;
                        let logger = function (level, ...args) {
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

                                if ((err.code === 'ETLS' || /SSL23_GET_SERVER_HELLO|\/deps\/openssl/.test(err.message) || err.code === 'ECONNRESET') && !this.tlsDisabled.has(ip)) {
                                    // STARTTLS failed, try again, this time without encryption
                                    log.info(this.logName, '%s.%s ERRCONNECT [%s] Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext', delivery.id, delivery.seq, connId, exchange.exchange, ip);
                                    plugins.handler.runHooks('sender:tlserror', [options, err], () => false);
                                    this.tlsDisabled.add(ip);
                                    return tryConnectIP(err, true);
                                }
                                if (!connected) {
                                    // try next host
                                    if (mxTry >= exchanges.length) {
                                        log.info(this.logName, '%s.%s ERRCONNECT [%s] %s[%s] for %s from %s (%s[%s]). "%s"', delivery.id, delivery.seq, connId, exchange.exchange, ip, domain, this.zone.name, delivery.zoneAddress.name, delivery.zoneAddress.address, err.message);
                                    }
                                    return tryConnectIP(err);
                                }

                                log.error(this.logName, '%s.%s ERRCONNECT [%s] Unexpected MX error. %s', delivery.id, delivery.seq, connId, err.message);
                                return callback(err);
                            };

                            connection.once('error', err => {
                                log.error(this.logName, '%s.%s CONNECTION [%s] %s', delivery.id, delivery.seq, connId, err.message);
                                _onError(err);
                            });

                            connection.once('end', () => {
                                log.verbose(this.logName, '%s.%s CLOSED [%s]', delivery.id, delivery.seq, connId);
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

                            log.verbose(this.logName, '%s.%s INITIALIZING [%s] (mx=%s mta=%s)', delivery.id, delivery.seq, connId, options.host, options.localAddress);
                            connection.connect(() => {
                                log.verbose(this.logName, '%s.%s INITIALIZED [%s] (mx=%s mta=%s)', delivery.id, delivery.seq, connId, options.host, options.localAddress);
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
            log.info(this.logName, '%s.%s SKIPBOUNCE Skip bounce to %s due to envelope (MAIL FROM=%s)', delivery.id, delivery.seq, delivery.from || '<>', JSON.stringify(delivery.from || '').replace(/"/g, '').trim() || '<>');
            return;
        }

        if (delivery.skipBounce) {
            log.info(this.logName, '%s.%s SKIPBOUNCE Skip bounce to %s as defined by routing', delivery.id, delivery.seq, delivery.from || '<>');
            return;
        }

        let xAutoResponseSuppress = delivery.headers.getFirst('X-Auto-Response-Suppress');
        if (/\ball\b/i.test(xAutoResponseSuppress)) {
            log.info(this.logName, '%s.%s SKIPBOUNCE Skip bounce to %s due to header (%s=%s)', delivery.id, delivery.seq, delivery.from || '<>', 'X-Auto-Response-Suppress', JSON.stringify(xAutoResponseSuppress).replace(/"/g, '').trim());
            return;
        }

        let autoSubmitted = delivery.headers.getFirst('Auto-Submitted');
        if (/\bauto\-(generated|replied)\b/i.test(autoSubmitted)) {
            log.info(this.logName, '%s.%s SKIPBOUNCE Skip bounce to %s due to header (%s=%s)', delivery.id, delivery.seq, delivery.from || '<>', 'Auto-Submitted', JSON.stringify(autoSubmitted).replace(/"/g, '').trim());
            return;
        }

        if (/^mailer\-daemon@/i.test(delivery.parsedEnvelope.from)) {
            log.info(this.logName, '%s.%s SKIPBOUNCE Skip bounce to %s due to header (%s=%s)', delivery.id, delivery.seq, delivery.from || '<>', 'From', JSON.stringify(delivery.parsedEnvelope.from || '<>').replace(/"/g, '').trim() || '<>');
            return;
        }

        console.log({
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
        });
    }
}

module.exports = Sender;
