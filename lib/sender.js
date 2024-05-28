'use strict';

const config = require('wild-config');
const log = require('npmlog');
const net = require('net');
const crypto = require('crypto');
const request = require('request');
const os = require('os');
const bounces = require('./bounces');
const Headers = require('mailsplit').Headers;
const SMTPConnection = require('nodemailer/lib/smtp-connection');
const tls = require('tls');
const dkimSign = require('./dkim-sign');
const StreamHash = require('./stream-hash');
const EventEmitter = require('events');
const plugins = require('./plugins');
const util = require('util');
const ByteCounter = require('./byte-counter');
const mxConnect = require('mx-connect');
const addressTools = require('./address-tools');
const libmime = require('libmime');
const db = require('./db');
const base32 = require('base32.js');

// handle DNS resolving
require('./ip-tools');

const DEFAULT_DEFER_TIMES =
    config.queue.deferTimes ||
    [
        5 /* 5 */, 7 /* 12 */, 8 /* 20 */, 25 /* 45 */, 75 /* 2h */, 120 /* 4h */, 240 /* 8h */, 240 /* 12h */, 240 /* 16h */, 240 /* 20h */, 240 /* 24h */,
        240 /* 28h */, 240 /* 32h */, 240 /* 36h */, 240 /* 40h */, 240 /* 44h */, 240 /* 48h */
    ].map(v => v * 60 * 1000);

const POLICY_RESPONSE = 'Failed to establish a TLS connection to the MX server as requested by policy';

class Sender extends EventEmitter {
    constructor(clientId, connectionId, zone, sendCommand, queue, connectionPool) {
        super();

        this.clientId = clientId;
        this.connectionId = connectionId;

        this.zone = zone;

        this.queue = queue;

        this.logName = 'Sender/' + this.zone.name + '/' + process.pid + '[' + connectionId + ']';

        this.deliveryTimer = false;

        this.connectionPool = connectionPool;

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

        this.mtaStsHandler = {
            enabled: config.mtaSts && config.mtaSts.enabled,
            cache: {
                set: async (domain, policy) => {
                    if (!db.redis) {
                        return;
                    }

                    try {
                        let expires = policy.expires ? new Date(policy.expires) : false;
                        let ttl = expires && expires.toString() !== 'Invalid Date' ? expires.getTime() - Date.now() : 0;
                        if (!ttl || ttl <= 0) {
                            ttl = 60 * 1000;
                        }

                        if (policy.error && policy.error.message) {
                            policy = Object.assign({}, policy, {
                                error: { message: policy.error.message, code: policy.error.code }
                            });
                        }

                        const json = JSON.stringify(policy);

                        log.verbose(this.logName + '/MTA-STS', 'Caching policy domain=%s ttl=%ss policy=%s', domain, Math.round(ttl / 1000), json);
                        await db.redis
                            .multi()
                            .set(`sts:${domain}`, json)
                            .expire(`sts:${domain}`, Math.round(ttl / 1000))
                            .exec();
                    } catch (err) {
                        log.error(this.logName + '/MTA-STS', 'Redis error domain=%s err=%s', domain, err.message);
                    }
                },

                get: async domain => {
                    if (!db.redis) {
                        return;
                    }
                    try {
                        let json = await db.redis.get(`sts:${domain}`);
                        if (json) {
                            log.verbose(this.logName + '/MTA-STS', 'Loaded policy domain=%s policy=%s', domain, json);

                            const policy = JSON.parse(json);

                            if (policy.error && policy.error.message) {
                                const error = new Error(policy.error.message);
                                for (let key of Object.keys(policy.error)) {
                                    if (key !== 'message') {
                                        error[key] = policy.error[key];
                                    }
                                }
                                policy.error = error;
                            }

                            return policy;
                        }
                    } catch (err) {
                        log.error(this.logName + '/MTA-STS', 'Redis error domain=%s err=%s', domain, err.message);
                    }
                }
            },
            logger: obj => {
                log.verbose(this.logName + '/MTA-STS', JSON.stringify(obj));
            }
        };

        log.verbose(this.logName, 'Created sender instance for %s', this.zone.name);

        setImmediate(() => this.sendNext());
    }

    close() {
        if (!this.closing) {
            log.info(this.logName, 'Closing sender instance for %s', this.zone && this.zone.name);
            this.closing = true;
        }
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
            plugins.handler.runHooks('sender:responseError', [delivery, connection, err], () => {
                this.handleResponseError(delivery, connection, err, continueSending);
            });
        };

        this.sendCommand('GET', (err, delivery) => {
            if (err) {
                log.error(this.logName, 'REQFAIL %s', err.message);
                return setTimeout(() => continueSending(), 1500).unref();
            }

            if (!delivery || !delivery.id) {
                this.emptyChecks++;
                clearTimeout(this.deliveryTimer);
                this.deliveryTimer = setTimeout(() => continueSending(), 1000);
                return;
            }

            if (!delivery.sessionId) {
                delivery.sessionId = base32.encode(crypto.randomBytes(10)).toLowerCase();
            }

            this.emptyChecks = 0;

            delivery.headers = new Headers(delivery.headers);

            delivery.envelope = {
                from: delivery.from,
                to: delivery.recipient
            };

            ['preferIPv6', 'ignoreIPv6', 'blockLocalAddresses'].forEach(key => {
                if (key in delivery.dnsOptions) {
                    return;
                }
                if (key in this.zone) {
                    delivery.dnsOptions[key] = this.zone[key];
                } else if (key in config.dns) {
                    delivery.dnsOptions[key] = config.dns[key];
                }
            });

            // prepare local IP address
            if (!delivery.dnsOptions.ignoreIPv6) {
                // prepare both IPv4 and IPv6 addresses as we don't know yet which one will be used
                delivery.zoneAddressIPv4 = this.zone.getAddress(delivery, false, delivery.disabledAddresses);
                delivery.zoneAddressIPv6 = this.zone.getAddress(delivery, true, delivery.disabledAddresses);
            } else {
                delivery.zoneAddress = this.zone.getAddress(delivery, false, delivery.disabledAddresses);
            }

            log.verbose(
                this.logName,
                'id=%s %s.%s FETCHED for delivery (from=%s to=%s)',
                delivery.sessionId,
                delivery.id,
                delivery.seq,
                delivery.from,
                delivery.recipient
            );

            plugins.handler.runHooks('sender:fetch', [delivery], err => {
                if (err) {
                    return handleError(delivery, false, err);
                }

                if (delivery.isSuppressed === true) {
                    return this.releaseDelivery(delivery, (/*err, released*/) => {
                        setTimeout(() => continueSending(), 1500).unref();
                    });
                }

                this.zone.speedometer(this.ref, () => {
                    // check throttling speed
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
                        let recivedHeader = Buffer.from(
                            this.zone.generateReceivedHeader(delivery, delivery.localHostname || (connection && connection.options.name) || os.hostname())
                        );
                        delivery.headers.addFormatted('Received', recivedHeader, 0);

                        if (err) {
                            return handleError(delivery, connection, err);
                        }

                        // set to true once we have sent a message or something fails
                        let connectionDone = false;

                        if (!connection.http) {
                            log.verbose(
                                this.logName,
                                'id=%s %s.%s [%s] CONNECTED mx=%s[%s]',
                                delivery.sessionId,
                                delivery.id,
                                delivery.seq,
                                connection.id,
                                connection.options.servername,
                                connection.options.host
                            );

                            // clear existing handlers
                            connection.removeAllListeners('error');
                            connection.removeAllListeners('end');

                            connection.once('error', err => {
                                log.error(
                                    this.logName,
                                    'id=%s %s.%s CONNECTION [%s] %s',
                                    delivery.sessionId,
                                    delivery.id,
                                    delivery.seq,
                                    connection.id,
                                    err.message
                                );

                                connection.close(); // just in case the connection is not closed
                                if (connectionDone) {
                                    return;
                                }
                                connectionDone = true;
                                return handleError(delivery, connection, err);
                            });

                            connection.once('end', () => {
                                log.info(
                                    this.logName,
                                    'id=%s %s.%s SMTPCLOSE [%s] Connection closed response="%s"',
                                    delivery.sessionId,
                                    delivery.id,
                                    delivery.seq,
                                    connection.id,
                                    connection.lastServerResponse || ''
                                );

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
                                    let host =
                                        (connection && connection.options && (connection.options.servername || connection.options.host)) || delivery.domain;

                                    let error = new Error(`Connection to ${host} closed unexpectedly`);
                                    error.response = `Network error: ${err.message}`;
                                    error.category = 'network';
                                    error.temporary = true;

                                    return handleError(delivery, connection, err);
                                }, 1000).unref();
                            });
                        }

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
                                    log.error(
                                        this.logName,
                                        'id=%s %s.%s FETCHFAIL [%s] error=%s',
                                        delivery.sessionId,
                                        delivery.id,
                                        delivery.seq,
                                        connection.id,
                                        err.message
                                    );
                                    messageStream.emit('error', err);
                                } else {
                                    log.error(
                                        this.logName,
                                        'id=%s %s.%s UNEXPECTED fetchfail [%s] error=%s',
                                        delivery.sessionId,
                                        delivery.id,
                                        delivery.seq,
                                        connection.id,
                                        err.message
                                    );
                                }
                            });
                            messageHash.once('hash', data => {
                                delivery.sentBodyHash = data.hash;
                                delivery.sentBodySize = data.bytes;
                                delivery.md5Match = delivery.sourceMd5 ? delivery.sourceMd5 === data.hash : true;
                            });

                            log.verbose(
                                this.logName,
                                'id=%s %s.%s SENDING [%s] (from=%s to=%s size=%s)',
                                delivery.sessionId,
                                delivery.id,
                                delivery.seq,
                                connection.id,
                                delivery.envelope.from,
                                delivery.envelope.to,
                                messageSize
                            );

                            let send = next => {
                                // Do the actual delivery
                                if (!connection.http) {
                                    // normal SMTP delivery
                                    connection.send(
                                        {
                                            from: delivery.envelope.from,
                                            to: [].concat(delivery.envelope.to || []) //,
                                            //size: messageSize
                                        },
                                        messageStream,
                                        next
                                    );
                                } else {
                                    // no bounces for HTTP uploads
                                    delivery.skipBounce = true;

                                    let chunk;
                                    let chunks = [];
                                    let chunklen = false;
                                    let returned = false;
                                    messageStream.on('readable', () => {
                                        while ((chunk = messageStream.read()) !== null) {
                                            chunks.push(chunk);
                                            chunklen += chunk.length;
                                        }
                                    });

                                    messageStream.once('error', err => {
                                        if (returned) {
                                            return;
                                        }
                                        returned = true;
                                        next(err);
                                    });

                                    messageStream.once('end', () => {
                                        if (returned) {
                                            return;
                                        }
                                        returned = true;

                                        let messageContent = Buffer.concat(chunks, chunklen);

                                        let subject = delivery.headers.getFirst('subject');
                                        try {
                                            subject = libmime.decodeWords(subject);
                                        } catch (E) {
                                            // ignore
                                        }
                                        subject = subject.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex

                                        let headerValues = {
                                            from: addressTools.parseAddressList(delivery.headers, 'from', true).map(addressNameDecoder).shift() || false,
                                            to: addressTools.parseAddressList(delivery.headers, 'to', true).map(addressNameDecoder),
                                            cc: addressTools.parseAddressList(delivery.headers, 'cc', true).map(addressNameDecoder),
                                            bcc: addressTools.parseAddressList(delivery.headers, 'bcc', true).map(addressNameDecoder),
                                            reply_to:
                                                addressTools.parseAddressList(delivery.headers, 'reply-to', true).map(addressNameDecoder).shift() || false,
                                            sender: addressTools.parseAddressList(delivery.headers, 'sender', true).map(addressNameDecoder).shift() || false,

                                            in_reply_to: delivery.headers.getFirst('In-Reply-To'),
                                            references: delivery.headers.getFirst('References'),
                                            date: delivery.headers.getFirst('Date'),
                                            message_id: delivery.headers.getFirst('Message-ID'),
                                            subject
                                        };

                                        // HTTP delivery
                                        let formData = {
                                            id: delivery.id + '.' + delivery.seq,
                                            from: delivery.from,
                                            to: delivery.recipient
                                        };

                                        Object.keys(headerValues).forEach(key => {
                                            if (
                                                !headerValues[key] ||
                                                ((typeof headerValues[key] === 'string' || Array.isArray(headerValues[key])) && !headerValues[key].length)
                                            ) {
                                                return false;
                                            }
                                            formData['headers[' + key + ']'] = JSON.stringify(headerValues[key]);
                                        });

                                        formData['mail_to_http[from]'] = delivery.from;
                                        formData['mail_to_http[rcpt]'] = delivery.recipient;
                                        formData['mail_to_http[real_length]'] = messageContent.length;
                                        formData['mail_to_http[body]'] =
                                            messageContent.length <= 500 * 1024 ? messageContent : messageContent.slice(0, 500 * 1024);

                                        formData.message = {
                                            value: messageContent,
                                            options: {
                                                filename: delivery.id + '.eml',
                                                contentType: 'message/rfc822'
                                            }
                                        };

                                        request.post(
                                            {
                                                url: connection.targetUrl,
                                                formData,
                                                headers: {
                                                    'User-Agent': config.uploads.userAgent
                                                }
                                            },
                                            (err, httpResponse, body) => {
                                                if (err) {
                                                    err.protocol = 'http';
                                                    err.httpUrl = connection.targetUrl;
                                                    err.httpResponse = (httpResponse && httpResponse.statusCode) || '-';

                                                    err.responseCode = (httpResponse && httpResponse.statusCode) || 550;
                                                    return next(err);
                                                }

                                                if (httpResponse.statusCode > 299 || httpResponse.statusCode < 200) {
                                                    err = new Error(
                                                        httpResponse.statusCode + ' Upload failed. Received ' + (body ? body.length : 0) + ' B response'
                                                    );

                                                    err.protocol = 'http';
                                                    err.httpUrl = connection.targetUrl;
                                                    err.httpResponse = (httpResponse && httpResponse.statusCode) || '-';

                                                    err.responseCode = (httpResponse && httpResponse.statusCode) || 550;
                                                    return next(err);
                                                }

                                                next(null, {
                                                    accepted: [].concat(delivery.envelope.to || []),
                                                    rejected: [],
                                                    protocol: 'http',
                                                    httpUrl: connection.targetUrl,
                                                    httpResponse: httpResponse.statusCode,
                                                    response:
                                                        'Message uploaded. Received ' +
                                                        (body ? body.length : 0) +
                                                        ' B response with status code ' +
                                                        httpResponse.statusCode +
                                                        '.'
                                                });
                                            }
                                        );
                                    });
                                }
                            };

                            // Do the actual delivery
                            send((err, info) => {
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
                                        log.verbose(
                                            this.logName,
                                            'id=%s %s.%s UNCLOSED [%s] Socket was not closed readsize=%s',
                                            delivery.sessionId,
                                            delivery.id,
                                            delivery.seq,
                                            connection.id,
                                            readsize
                                        );
                                    });
                                }

                                if (!err && info && connectionDone) {
                                    // message seems to be sent but connection is already ended
                                    log.error(
                                        this.logName,
                                        'id=%s %s.%s UNEXPECTED [%s] message delivery: %s',
                                        delivery.sessionId,
                                        delivery.id,
                                        delivery.seq,
                                        connection.id,
                                        JSON.stringify(info)
                                    );
                                }

                                // LMTP mode has errors in response
                                if (delivery.useLMTP && !err && info && info.rejected && info.rejected.length) {
                                    err = new Error(info.response);
                                }

                                // ignore any future events regarding this connection
                                connectionDone = true;

                                // count the reusage
                                connection.usageCount = (Number(connection.usageCount || 0) || 0) + 1;

                                let connCacheConfig = this.zone.connectionCache || { ttl: 5, reuseCount: 100 };
                                let connCacheTTL = connCacheConfig.ttl || 5;
                                let connCacheMaxReuse = connCacheConfig.reuseCount || 100;

                                if (!err && delivery.connectionKey && connection.usageCount < connCacheMaxReuse) {
                                    // keep connection alive max 5 seconds or new delivery is found
                                    this.connectionPool.add(delivery.connectionKey, connection, connCacheTTL);
                                } else {
                                    // Connection reused to many times. Kill it.
                                    this.connectionPool.killConnection(err, connection);
                                }

                                let messageStats = messageStream.stats();

                                if (err) {
                                    messageStream = null;
                                    messageFetch = null;
                                    err.messageStats = messageStats;
                                    return handleError(delivery, connection, err);
                                }

                                let envelopeFrom = (delivery.envelope && delivery.envelope.from) || delivery.from;
                                let envelopeRecipient = (delivery.envelope && delivery.envelope.to) || delivery.recipient;

                                log.info(
                                    this.logName,
                                    'id=%s %s.%s ACCEPTED from=%s to=%s src=%s mx=%s id=%s (%s)',
                                    delivery.sessionId,
                                    delivery.id,
                                    delivery.seq,
                                    (delivery.from || '') + (delivery.from !== envelopeFrom ? '[' + envelopeFrom + ']' : '') || '<>',
                                    envelopeRecipient || '',
                                    delivery.localAddress || (connection && connection.options.localAddress) || '',
                                    (connection && connection.options.servername + '[' + connection.options.host + ']') || delivery.domain || '',
                                    delivery.headers.getFirst('Message-ID'),
                                    bounces.formatSMTPResponse(info.response)
                                );

                                plugins.handler.remotelog(delivery.id, delivery.seq, 'ACCEPTED', {
                                    zone: this.zone.name,
                                    from: delivery.from,
                                    returnPath: (delivery.envelope && delivery.envelope.from) || delivery.from,
                                    to: (delivery.envelope && delivery.envelope.to) || delivery.recipient,
                                    mx: connection.options.servername || delivery.domain,
                                    host: connection.options.host,
                                    ip: connection.options.localAddress,
                                    response: bounces.formatSMTPResponse(info.response).substr(0, 312),
                                    size: messageStats.size,
                                    timer: messageStats.time,
                                    start: messageStats.start,
                                    messageId: delivery.messageId || delivery.id,

                                    protocol: info.protocol || (!delivery.useLMTP ? 'smtp' : 'lmtp'),
                                    httpUrl: info.httpUrl,
                                    httpResponse: info.httpResponse
                                });

                                delivery.status = {
                                    delivered: true,
                                    ip: connection.options.localAddress,
                                    mx: connection.options.servername || delivery.domain,
                                    response: bounces.formatSMTPResponse(info.response)
                                };

                                this.releaseDelivery(delivery, (err, released) => {
                                    if (err) {
                                        log.error(
                                            this.logName,
                                            'id=%s %s.%s Can not get message acknowledged. %s',
                                            delivery.sessionId,
                                            delivery.id,
                                            delivery.seq,
                                            err.message
                                        );

                                        this.closing = true;
                                        return this.emit('error', err);
                                    }

                                    if (!released) {
                                        log.info(
                                            this.logName,
                                            'id=%s %s.%s NOTFOUND Failed to release delivery',
                                            delivery.sessionId,
                                            delivery.id,
                                            delivery.seq
                                        );
                                    }

                                    plugins.handler.runHooks('sender:delivered', [delivery, info], err => {
                                        if (err) {
                                            log.error(
                                                this.logName,
                                                'id=%s %s.%s Failed to process sender:delivered hook. %s',
                                                delivery.sessionId,
                                                delivery.id,
                                                delivery.seq,
                                                err.message
                                            );
                                        }

                                        return setImmediate(() => continueSending());
                                    });
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

        if (err.protocol === 'http') {
            // mail2http failures
            bounce = {
                action: err.httpResponse >= 400 && err.httpResponse < 500 ? 'reject' : 'defer',
                category: 'http',
                message: err.response || err.message,
                code: err.httpResponse,
                status: false
            };
        } else if (['dns', 'network', 'policy'].includes(err.category)) {
            // preset categories from mx-connect etc
            bounce = {
                action: err.temporary || err.action === 'defer' ? 'defer' : 'reject',
                category: err.category,
                message: err.response || err.message,
                status: false
            };
        } else if (!err.responseCode && !/^\d{3}\b/.test(err.response || err.message)) {
            // timeouts, node network errors etc.
            bounce = {
                action: 'defer',
                category: 'network',
                message: err.response || err.message,
                status: false
            };
        } else {
            bounce = bounces.check(err.response || err.message, err.category);
        }

        bounce.action = err.action || bounce.action;

        let deferredCount = (delivery._deferred && delivery._deferred.count) || 0;
        let smtpResponse = bounces.formatSMTPResponse(err.response || err.message);
        let smtpLog = (connection && connection.logtrail) || err.logtrail;

        let envelopeFrom = (delivery.envelope && delivery.envelope.from) || delivery.from;
        let envelopeRecipient = (delivery.envelope && delivery.envelope.to) || delivery.recipient;

        if (bounce.category === 'blacklist' && (delivery.poolDisabled || !envelopeFrom)) {
            // blacklisted IP
            // no available IP addresses left or its a bounce message, give up delivering it
            bounce.action = 'reject';
        }

        const deferTimes = delivery.deferTimes && Array.isArray(delivery.deferTimes) && delivery.deferTimes.length ? delivery.deferTimes : DEFAULT_DEFER_TIMES;

        if (bounce.action !== 'reject' && deferredCount < deferTimes.length) {
            const ttl = deferTimes[deferredCount];
            log.info(
                this.logName,
                'id=%s %s.%s DEFERRED[%s] from=%s to=%s src=%s mx=%s id=%s (%s)',
                delivery.sessionId,
                delivery.id,
                delivery.seq,
                bounce.category,
                (delivery.from || '') + (delivery.from !== envelopeFrom ? '[' + envelopeFrom + ']' : '') || '<>',
                envelopeRecipient || '',
                delivery.localAddress || (connection && connection.options.localAddress) || '',
                (connection && connection.options.servername + '[' + connection.options.host + ']') || delivery.domain || '',
                delivery.headers.getFirst('Message-ID'),
                smtpResponse
            );

            plugins.handler.remotelog(delivery.id, delivery.seq, 'DEFERRED', {
                category: bounce.category,
                defcount: deferredCount + 1,
                nextattempt: Date.now() + ttl,
                zone: this.zone.name,
                from: delivery.from,
                returnPath: (delivery.envelope && delivery.envelope.from) || delivery.from,
                to: (delivery.envelope && delivery.envelope.to) || delivery.recipient,
                mx: (connection && connection.options.servername) || delivery.domain,
                host: connection && connection.options.host,
                ip: connection && connection.options.localAddress,
                response: smtpResponse.substr(0, 312),
                size: err.messageStats && err.messageStats.size,
                timer: err.messageStats && err.messageStats.time,
                start: err.messageStats && err.messageStats.start,
                messageId: delivery.messageId || delivery.id,

                protocol: err.protocol || (!delivery.useLMTP ? 'smtp' : 'lmtp'),
                httpUrl: err.httpUrl,
                httpResponse: err.httpResponse
            });

            return this.deferDelivery(delivery, ttl, smtpLog, smtpResponse, bounce, (err, deferred) => {
                if (err) {
                    log.error(this.logName, 'id=%s %s.%s %s', delivery.sessionId, delivery.id, delivery.seq, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }
                if (!deferred) {
                    log.info(this.logName, 'id=%s %s.%s NOTFOUND Failed to defer delivery', delivery.sessionId, delivery.id, delivery.seq);
                }
                return callback();
            });
        } else {
            log.info(
                this.logName,
                'id=%s %s.%s REJECTED[%s] from=%s to=%s src=%s mx=%s id=%s (%s)',
                delivery.sessionId,
                delivery.id,
                delivery.seq,
                bounce.category,
                (delivery.from || '') + (delivery.from !== envelopeFrom ? '[' + envelopeFrom + ']' : '') || '<>',
                envelopeRecipient,
                delivery.localAddress || (connection && connection.options.localAddress) || '',
                (connection && connection.options.servername + '[' + connection.options.host + ']') || delivery.domain || '',
                delivery.headers.getFirst('Message-ID'),
                smtpResponse
            );

            plugins.handler.remotelog(delivery.id, delivery.seq, 'REJECTED', {
                category: bounce.category,
                zone: this.zone.name,
                from: delivery.from,
                returnPath: (delivery.envelope && delivery.envelope.from) || delivery.from,
                to: (delivery.envelope && delivery.envelope.to) || delivery.recipient,
                mx: (connection && connection.options.servername) || delivery.domain,
                host: connection && connection.options.host,
                ip: connection && connection.options.localAddress,
                response: smtpResponse.substr(0, 312),
                size: err.messageStats && err.messageStats.size,
                timer: err.messageStats && err.messageStats.time,
                start: err.messageStats && err.messageStats.start,
                messageId: delivery.messageId || delivery.id,

                protocol: err.protocol || (!delivery.useLMTP ? 'smtp' : 'lmtp'),
                httpUrl: err.httpUrl,
                httpResponse: err.httpResponse
            });

            delivery.status = {
                delivered: false,
                mx: (connection && connection.options.servername) || delivery.domain,
                response: smtpResponse
            };

            return this.releaseDelivery(delivery, (err, released) => {
                if (err) {
                    log.error(this.logName, 'id=%s %s.%s %s', delivery.sessionId, delivery.id, delivery.seq, err.message);
                    this.closing = true;
                    return this.emit('error', err);
                }

                if (released) {
                    setImmediate(() => this.sendBounceMessage(delivery, bounce, smtpResponse));
                } else {
                    log.info(this.logName, 'id=%s %s.%s NOTFOUND Failed to release delivery', delivery.sessionId, delivery.id, delivery.seq);
                }

                return callback();
            });
        }
    }

    getConnectionWithCache(delivery, callback) {
        if (delivery.http) {
            if (!delivery.targetUrl) {
                let err = new Error('No target URL defined for HTTP message');
                err.responseCode = 550;
                return callback(err);
            }

            return callback(null, {
                id: crypto.randomBytes(8).toString('base64').replace(/\W/g, ''),
                http: true,
                targetUrl: delivery.targetUrl,
                options: {
                    address: delivery.zoneAddress && delivery.zoneAddress.address,
                    name: delivery.zoneAddress && delivery.zoneAddress.name
                }
            });
        }

        const cacheKey = [
            'domain',
            (delivery.mx && delivery.mx.length && delivery.mx[0] && delivery.mx[0].exchange) || delivery.domain,
            delivery.mxAuth && delivery.mxAuth.user,
            delivery.mxPort
        ]
            .filter(val => val)
            .join(':');

        this.sendCommand(
            {
                cmd: 'GETCACHE',
                key: this.zone.name + ':' + cacheKey
            },
            (err, domainData) => {
                if (err) {
                    return callback(err);
                }

                if (domainData && domainData.error) {
                    let err = new Error(domainData.error);
                    for (let key of ['response', 'category', 'temporary', 'code']) {
                        if (domainData[key]) {
                            err[key] = domainData[key];
                        }
                    }

                    return callback(err);
                }

                this.getConnection(delivery, (err, connection) => {
                    let cmd;
                    if (err && !err.netConnected) {
                        // connection ended with an error without being able to establish an opened socket
                        let ttl;
                        let domainData = {};

                        // if we were not able to successfully connect to a server then store error result
                        domainData.error = err.message;
                        domainData.response = err.response;
                        domainData.category = err.category;
                        domainData.temporary = err.temporary;
                        domainData.code = err.code;

                        if (err.lastErr && [err.lastErr.errno, err.lastErr.code].includes('ETIMEDOUT')) {
                            // most probably a firewall issue or a server that does not have MX running
                            ttl = 15 * 60 * 1000;
                        } else {
                            // auto defer all messages to this server for the next 2 minutes
                            ttl = 2 * 60 * 1000;
                        }
                        cmd = {
                            cmd: 'SETCACHE',
                            key: this.zone.name + ':' + cacheKey,
                            value: domainData,
                            ttl
                        };
                    } else {
                        // might have been an error with SMTP but at least we got a socket opened
                        // if the server was blocked then this update would release it
                        cmd = {
                            cmd: 'CLEARCACHE',
                            key: this.zone.name + ':' + cacheKey
                        };
                    }

                    setImmediate(() => callback(err, connection));

                    this.sendCommand(cmd, () => false);
                });
            }
        );
    }

    getConnection(delivery, done) {
        let netConnected = false;
        let callbackReturned = false;

        let callback = (...args) => {
            if (callbackReturned) {
                return;
            }
            callbackReturned = true;

            if (args[0] && typeof args[0] === 'object') {
                // indicate in the error object that we actually were able to open
                // a tcp socket to the destination, so do not block this host
                args[0].netConnected = netConnected;
                return done(...args);
            }

            plugins.handler.runHooks('sender:connection', [delivery, args[1]], () => done(...args));
        };

        let mxLastError = false;
        let ignoreMXHosts = [];
        let ignoreTLS = !!this.zone.ignoreTLS || false;

        let tryConnect = () => {
            delivery.mxPort = delivery.mxPort || this.zone.port || 25;

            let logtrail = [];
            let logger = (level, meta, ...args) => {
                logtrail.push({
                    time: Date.now(),
                    level,
                    tnx: meta.tnx,
                    message: util.format(...args)
                });
                if (delivery.logger) {
                    util.format(...args)
                        .split('\n')
                        .forEach(line => {
                            log.info(
                                'Sender/' + this.zone.name + '/' + process.pid,
                                'id=%s %s.%s SMTP %s: %s',
                                delivery.sessionId,
                                delivery.id,
                                delivery.seq,
                                level,
                                line
                            );
                        });
                }
            };

            log.info(this.logName, 'id=%s %s.%s CONNECTING domain=%s port=%s', delivery.sessionId, delivery.id, delivery.seq, delivery.domain, delivery.mxPort);
            plugins.handler.runHooks('sender:connecting', [delivery], () => false);

            let startTime = Date.now();

            // create the connection cache key
            // prefer IPv6 if wished
            let zoneAddress = delivery.zoneAddress || delivery.zoneAddressIPv4;
            if (this.zone.preferIPv6 && delivery.zoneAddressIPv6) {
                zoneAddress = delivery.zoneAddressIPv6;
            }
            delivery.connectionKey = delivery.connectionKey || [zoneAddress.address, this.zone.host || delivery.domain, delivery.mxPort].join(':');

            // check if there is a connection with this key
            if (this.connectionPool.has(delivery.connectionKey)) {
                // get already checked connection
                let conn = this.connectionPool.getConnection(delivery.connectionKey);
                if (conn) {
                    log.info(
                        this.logName,
                        'id=%s %s.%s CONNREUSE [%s] count=%s mx=%s mta=%s',
                        delivery.sessionId,
                        delivery.id,
                        delivery.seq,
                        conn.connection.id,
                        conn.connection.usageCount,
                        conn.connection.options.servername || conn.connection.options.host,
                        zoneAddress.address
                    );
                    return callback(null, conn.connection);
                }
            }

            // Resolve MX hosts for delivery domain and try to get a TCP connection to it
            // The method tries all possible MX hosts in the exchange priority order (max 20 IP addresses)
            let mxOptions = {
                target: delivery.domain,
                port: delivery.mxPort,
                dnsOptions: delivery.dnsOptions,
                ignoreMXHosts,
                mxLastError
            };

            if (delivery.mx) {
                mxOptions.mx = [].concat(delivery.mx);
            } else if (this.zone.host) {
                let mx = {
                    priority: 0,
                    exchange: this.zone.host,
                    A: [],
                    AAAA: []
                };
                if (net.isIPv4(this.zone.host)) {
                    mx.A.push(this.zone.host);
                } else if (net.isIPv6(this.zone.host)) {
                    mx.AAAA.push(this.zone.host);
                }
                mxOptions.mx = [mx];
            }

            if (delivery.zoneAddressIPv4) {
                mxOptions.localAddressIPv4 = delivery.zoneAddressIPv4.address;
                mxOptions.localHostnameIPv4 = delivery.zoneAddressIPv4.name;
            }

            if (delivery.zoneAddressIPv6) {
                mxOptions.localAddressIPv6 = delivery.zoneAddressIPv6.address;
                mxOptions.localHostnameIPv6 = delivery.zoneAddressIPv6.name;
            }

            if (delivery.zoneAddress) {
                mxOptions.localAddress = delivery.zoneAddress.address;
                mxOptions.localHostname = delivery.zoneAddress.name;
            }

            mxOptions.connectHook = (opts, connOpts, cb) => plugins.handler.runHooks('sender:connect', [delivery, connOpts], cb);

            mxOptions.connectError = (err, opts, connOpts) => {
                log.error(
                    this.logName,
                    'id=%s %s.%s CONNFAIL domain=%s local=%s[%s] remote=%s:%s error=%s',
                    delivery.sessionId,
                    delivery.id,
                    delivery.seq,
                    opts.domain,
                    connOpts.localHostname,
                    connOpts.localAddress,
                    connOpts.host,
                    connOpts.port,
                    err.message
                );
            };

            mxOptions.mtaSts = delivery.skipSTS
                ? {
                      enabled: false
                  }
                : this.mtaStsHandler;

            mxConnect(mxOptions, (err, mx) => {
                if (err) {
                    // could not connect to MX
                    log.error(
                        this.logName,
                        'id=%s %s.%s ERRCONNECT domain=%s error=%s',
                        delivery.sessionId,
                        delivery.id,
                        delivery.seq,
                        delivery.domain,
                        err.message
                    );
                    return callback(err);
                }

                let enforceTLS = (mx.policyMatch && mx.policyMatch.mode === 'enforce') || false;
                if (enforceTLS && ignoreTLS) {
                    ignoreTLS = false;
                }

                netConnected = true;
                delivery.localAddress = mx.localAddress;
                delivery.localHostname = mx.localHostname;
                delivery.localPort = mx.localPort;

                log.info(
                    this.logName,
                    'id=%s %s.%s CONNECTED domain=%s mx=%s[%s] src=%s[%s]',
                    delivery.sessionId,
                    delivery.id,
                    delivery.seq,
                    delivery.domain,
                    mx.hostname,
                    mx.host,
                    delivery.localHostname,
                    delivery.localAddress
                );

                delivery.mxHostname = mx.hostname || mx.host;

                let options = {
                    servername: mx.hostname,
                    host: mx.host,
                    port: delivery.mxPort,

                    // Use an existing TCP connection instead of creating a new connection
                    connection: mx.socket,

                    localAddress: delivery.localAddress,
                    name: delivery.localHostname,

                    lmtp: !!delivery.useLMTP,

                    ignoreTLS,
                    opportunisticTLS: !enforceTLS,

                    secure: 'mxSecure' in delivery ? !!delivery.mxSecure : !!this.zone.secure,

                    authMethod: this.zone.authMethod,

                    connectionTimeout: 5 * 60 * 1000,
                    greetingTimeout: 2 * 60 * 1000,

                    tls: {
                        servername: mx.hostname,
                        rejectUnauthorized: enforceTLS,
                        minVersion: enforceTLS ? 'TLSv1.2' : 'TLSv1'
                    },

                    transactionLog: true,
                    logger: {
                        info: logger.bind(null, 'INF'),
                        debug: logger.bind(null, 'DBG'),
                        error: logger.bind(null, 'ERR')
                    },
                    debug: 'debug' in this.zone ? this.zone.debug : config.log.queue
                };

                let connection = new SMTPConnection(options);
                connection.logtrail = logtrail;

                let connId = connection.id;
                let returned = false;

                let _onError = err => {
                    connection.connected = false;
                    if (returned) {
                        return;
                    }
                    returned = true;

                    if (/disconnected\s+before\s+secure\s+TLS\s+connection\s+was\s+established/i.test(err.message) || err.cert) {
                        if (enforceTLS) {
                            // policy violation
                            err.response = `Policy error: ${POLICY_RESPONSE}${err.reason ? `. ${err.reason}` : ''}`;
                            err.category = 'policy';
                            err.temporary = false;
                        } else {
                            // try to reconnect without TLS
                            err.code = 'ETLS';
                        }
                    }

                    err.response = err.response || `Nework error: Error connecting to ${mx.host}. ${err.message}`;
                    err.category = err.category || 'network';
                    err.logtrail = logtrail;
                    if (typeof err.temporary !== 'boolean') {
                        err.temporary = true;
                    }

                    if (
                        (err.code === 'ETLS' ||
                            /SSL23_GET_SERVER_HELLO|\/deps\/openssl|ssl3_check|ssl3_get_record|SSL routines/i.test(err.message) ||
                            err.code === 'ECONNRESET') &&
                        !ignoreTLS &&
                        !enforceTLS
                    ) {
                        // STARTTLS failed, try again, this time without encryption
                        log.info(
                            this.logName,
                            'id=%s %s.%s ERRCONNECT [%s] Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext. %s',
                            delivery.sessionId,
                            delivery.id,
                            delivery.seq,
                            connId,
                            mx.hostname,
                            mx.host,
                            err.message
                        );
                        plugins.handler.runHooks('sender:tlserror', [delivery, options, err], () => false);
                        ignoreTLS = true;

                        // Retry connecting to destination host. This time TLS would be disabled
                        return tryConnect();
                    }

                    if (err.code === 'ETIMEDOUT') {
                        // retry to some other MX
                        ignoreMXHosts.push(mx.host);
                        mxLastError = err;
                        return tryConnect();
                    }

                    log.error(
                        this.logName,
                        'id=%s %s.%s ERRCONNECT [%s] Unexpected MX error. src=%s error="%s"',
                        delivery.sessionId,
                        delivery.id,
                        delivery.seq,
                        connId,
                        delivery.localAddress,
                        err.message
                    );
                    return callback(err);
                };

                connection.once('error', err => {
                    log.error(
                        this.logName,
                        'id=%s %s.%s SMTPERR [%s] src=%s error="%s"',
                        delivery.sessionId,
                        delivery.id,
                        delivery.seq,
                        connId,
                        delivery.localAddress,
                        err.message
                    );
                    _onError(err);
                });

                connection.once('end', () => {
                    log.info(
                        this.logName,
                        'id=%s %s.%s SMTPCLOSE [%s] Closed prematurely src=%s response="%s" connected=%ss.',
                        delivery.sessionId,
                        delivery.id,
                        delivery.seq,
                        connId,
                        delivery.localAddress,
                        connection.lastServerResponse || '',
                        (Date.now() - startTime) / 1000
                    );
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
                            err.code = 'ETLS';
                        }
                        _onError(err);
                    }, 1000).unref();
                });

                log.verbose(
                    this.logName,
                    'id=%s %s.%s INITIALIZING [%s] (mx=%s src=%s)',
                    delivery.sessionId,
                    delivery.id,
                    delivery.seq,
                    connId,
                    options.host,
                    delivery.localAddress
                );

                connection.connect(() => {
                    log.verbose(
                        this.logName,
                        'id=%s %s.%s INITIALIZED [%s] (mx=%s src=%s)',
                        delivery.sessionId,
                        delivery.id,
                        delivery.seq,
                        connId,
                        options.host,
                        delivery.localAddress
                    );

                    if (returned) {
                        return connection.close();
                    }

                    if (enforceTLS && !connection.secure) {
                        returned = true;
                        connection.close();
                        let err = new Error('TLS is required');
                        err.response = `Policy error: ${POLICY_RESPONSE}`;
                        err.category = 'policy';
                        return callback(err);
                    }

                    plugins.handler.runHooks('sender:connected', [delivery, connection, options, !!connection.secure], () => false);

                    let auth = next => {
                        let authData = delivery.mxAuth || this.zone.auth;
                        if (authData) {
                            return connection.login(authData, next);
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
                        connection.connected = true;
                        return callback(null, connection);
                    });
                });
            });
        };
        tryConnect();
    }

    releaseDelivery(delivery, callback) {
        this.sendCommand(
            {
                cmd: 'RELEASE',
                id: delivery.id,
                domain: delivery.domain,
                to: delivery.recipient,
                seq: delivery.seq,
                status: delivery.status,
                address: delivery.localAddress || (delivery.zoneAddress && delivery.zoneAddress.address),
                _lock: delivery._lock
            },
            (err, updated) => {
                if (err) {
                    return callback(err);
                }
                callback(null, updated);
            }
        );
    }

    deferDelivery(delivery, ttl, smtpLog, smtpResponse, bounce, callback) {
        this.sendCommand(
            {
                cmd: 'DEFER',
                id: delivery.id,
                seq: delivery.seq,
                _lock: delivery._lock,
                ttl,
                response: smtpResponse,
                address: delivery.localAddress || (delivery.zoneAddress && delivery.zoneAddress.address),
                category: bounce.category,
                updates: delivery.updates,
                log: smtpLog
            },
            (err, updated) => {
                if (err) {
                    return callback(err);
                }
                callback(null, updated);
            }
        );
    }

    signMessage(delivery) {
        if (!delivery.dkim) {
            return;
        }
        []
            .concat(delivery.dkim.keys || [])
            .reverse()
            .forEach(key => {
                let dkimHeader;
                dkimHeader = dkimSign.sign(delivery.headers, delivery.dkim.hashAlgo, delivery.dkim.bodyHash, key);
                if (dkimHeader) {
                    delivery.headers.addFormatted('dkim-signature', dkimHeader);
                }
            });
    }

    sendBounceMessage(delivery, bounce, smtpResponse) {
        if (!bounces.canSendBounce(delivery, { logName: this.logName })) {
            return false;
        }

        this.sendCommand(
            {
                cmd: 'BOUNCE',
                id: delivery.id,
                sessionId: delivery.sessionId,

                zone: this.zone.name,
                interface: delivery.interface,
                from: delivery.from,
                to: delivery.recipient,
                seq: delivery.seq,
                headers: delivery.headers.getList(),

                address: delivery.localAddress || (delivery.zoneAddress && delivery.zoneAddress.address),
                name: (delivery.account && delivery.account.returnPathDomain) || delivery.localHostname || (delivery.zoneAddress && delivery.zoneAddress.name),
                mxHostname: delivery.mxHostname,

                returnPath: delivery.from,
                category: bounce.category,
                time: Date.now(),
                arrivalDate: delivery.created,
                response: smtpResponse,

                fbl: delivery.fbl
            },
            err => {
                if (err) {
                    this.close();
                    this.emit('error', err);
                    log.error(this.logName, 'id=%s %s.%s %s', delivery.sessionId, delivery.id, delivery.seq, err.message);
                    return;
                }
            }
        );
    }
}

function addressNameDecoder(addr) {
    if (addr.name) {
        try {
            addr.name = libmime.decodeWords(addr.name);
        } catch (E) {
            // ignore
        }
        addr.name = addr.name.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex
    }
    if (Array.isArray(addr.group)) {
        addr.group = addr.group.map(addressNameDecoder);
    }
    return addr;
}

module.exports = Sender;
