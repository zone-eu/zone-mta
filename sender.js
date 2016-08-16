'use strict';

// NB! This script is ran as a separate process, so no direct access to the queue, no data
// sharing with other part of the code etc.

const SendingZone = require('./lib/sending-zone').SendingZone;
const config = require('config');
const log = require('npmlog');
const fetch = require('nodemailer-fetch');
const iptools = require('./lib/iptools');
const bounces = require('./lib/bounces');
const createHeaders = require('./lib/headers');
const SMTPConnection = require('smtp-connection');
const net = require('net');
const crypto = require('crypto');
const PassThrough = require('stream').PassThrough;
const dkimSign = require('./lib/dkim-sign');
const QueueClient = require('./lib/transport/client');
const queueClient = new QueueClient(config.queueServer);

const SRS = require('srs.js');
const srsRewriter = new SRS({
    secret: config.srs.secret
});

let cmdId = 0;
let responseHandlers = new Map();

let closing = false;
let zone;

// Read command line arguments
let currentZone = (process.argv[2] || '').toString().trim().toLowerCase();
let clientId = (process.argv[3] || '').toString().trim().toLowerCase() || crypto.randomBytes(10).toString('hex');

// Find and setup correct Sending Zone
[].concat(config.zones || []).find(sendingZone => {
    if (sendingZone.name === currentZone) {
        zone = new SendingZone(sendingZone, false);
        return true;
    }
    return false;
});

if (!zone) {
    log.error('Sender/' + process.pid, 'Unknown Zone %s', currentZone);
    return process.exit(5);
}

log.level = 'logLevel' in zone ? zone.logLevel : config.log.level;
log.info('Sender/' + zone.name + '/' + process.pid, 'Starting sending for %s', zone.name);

process.title = 'zone-mta: sender process [' + currentZone + ']';

function sendCommand(cmd, callback) {
    let id = ++cmdId;
    let data = {
        req: id,
        zone: zone.name,
        client: clientId
    };

    if (typeof cmd === 'string') {
        cmd = {
            cmd
        };
    }

    Object.keys(cmd).forEach(key => data[key] = cmd[key]);
    responseHandlers.set(id, callback);
    queueClient.send(data);
}

function sender() {
    let ref = {}; // we need a new object value for WeakMap references

    let emptyChecks = 0;
    let sendNext = () => {
        if (closing) {
            return;
        }

        sendCommand('GET', (err, delivery) => {
            if (err) {
                closing = true;
                log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                return;
            }

            if (!delivery || !delivery.id) {
                emptyChecks++;
                return setTimeout(sendNext, Math.min(Math.pow(emptyChecks, 2), 1000) * 10);
            }
            emptyChecks = 0;

            delivery.headers = createHeaders(delivery.headers);

            zone.speedometer(ref, () => { // check throttling speed
                // Try to connect to the recipient MX
                getConnection(zone, delivery, (err, connection) => {
                    if (err) {
                        return handleResponseError(delivery, false, err, sendNext);
                    }

                    let recivedHeader = Buffer.from(zone.generateReceivedHeader(delivery, connection.options.name));
                    delivery.headers.addFormatted('Received', recivedHeader, 0);

                    if (config.dkim.enabled) {
                        // tro to sign the message, this would prepend a DKIM-Signature header to the message
                        signMessage(delivery);
                    }

                    let messageHeaders = delivery.headers.build();
                    let messageSize = recivedHeader.length + messageHeaders.length + delivery.bodySize; // required for SIZE argument
                    let messageFetch = fetch('http://' + config.api.hostname + ':' + config.api.port + '/fetch/' + delivery.id + '?body=yes');
                    let messageStream = new PassThrough();

                    messageStream.write(messageHeaders);
                    messageFetch.pipe(messageStream);
                    messageFetch.on('error', err => messageStream.emit('error', err));

                    let envelopeFrom = delivery.from;
                    if (config.srs.enabled) {
                        let senderDomain = envelopeFrom.substr(envelopeFrom.lastIndexOf('@') + 1).toLowerCase();
                        if (!config.srs.excludeDomains.includes(senderDomain)) {
                            envelopeFrom = srsRewriter
                                .rewrite(envelopeFrom.substr(0, envelopeFrom.lastIndexOf('@')), senderDomain) +
                                '@' + config.srs.rewriteDomain;
                        }
                    }

                    // Do the actual delivery
                    connection.send({
                        from: envelopeFrom,
                        to: [].concat(delivery.to || []),
                        size: messageSize
                    }, messageStream, (err, info) => {
                        // kill this connection, we don't need it anymore
                        connection.close();

                        if (err) {
                            messageStream = null;
                            messageFetch = null;
                            return handleResponseError(delivery, connection, err, sendNext);
                        }

                        log.info('Sender/' + zone.name + '/' + process.pid, 'ACCEPTED %s.%s for <%s> by %s (%s)', delivery.id, delivery.seq, delivery.to, delivery.domain, formatSMTPResponse(info.response));
                        return releaseDelivery(delivery, err => {
                            if (err) {
                                log.error('Sender/' + zone.name + '/' + process.pid, 'Can\'t get message acknowledged');
                                log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                                closing = true;
                                return;
                            }

                            // Safe to move on the next message
                            return sendNext();
                        });
                    });
                });
            });
        });
    };
    sendNext();
}

function handleResponseError(delivery, connection, err, callback) {
    let bounce;
    let deferredCount = delivery._deferred && delivery._deferred.count || 0;
    let smtpResponse = formatSMTPResponse(err.response || err.message);

    if ((bounce = bounces.check(err.response)).action !== 'reject' || deferredCount > 6) {
        let ttl = Math.min(Math.pow(5, deferredCount + 1), 1024) * 60 * 1000;
        log.info('Sender/' + zone.name + '/' + process.pid, 'DEFERRED[%s] %s.%s for <%s> by %s: %s (%s)', bounce.category, delivery.id, delivery.seq, delivery.to, delivery.domain, bounce.message, smtpResponse);
        return deferDelivery(delivery, ttl, err => {
            if (err) {
                log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                closing = true;
                return;
            }
            return callback();
        });
    } else {
        log.info('Sender/' + zone.name + '/' + process.pid, 'REJECTED[%s] %s.%s for <%s> by %s: %s (%s)', bounce.category, delivery.id, delivery.seq, delivery.to, delivery.domain, bounce.message, smtpResponse);
        return releaseDelivery(delivery, err => {
            if (err) {
                log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                closing = true;
                return;
            }
            return callback();
        });
    }
}

function getConnection(zone, delivery, callback) {
    let domain = delivery.domain;
    iptools.resolveMx(domain, (err, exchanges) => {
        if (err) {
            return callback(err);
        }

        if (!exchanges) {
            // mark as bounced
            err.response = '550 Can\'t find an MX server for ' + domain;
        }

        let connection;
        let mxTry = 0;

        let tryConnectMX = () => {
            let err;
            if (mxTry >= exchanges.length) {
                err = new Error('Can\'t connect to MX');
                err.response = '450 Can\'t connect to any MX server for ' + domain;
                return callback(err);
            }
            let exchange = exchanges[mxTry++];
            iptools.resolveIp(exchange.exchange, zone, (err, ipList) => {
                if (err) {
                    log.silly('Sender/' + zone.name + '/' + process.pid, 'Error resolving A/AAAA for %s. %s', exchange.exchange, err.message);
                    return tryConnectMX();
                }
                if (!ipList.length) {
                    log.silly('Sender/' + zone.name + '/' + process.pid, 'Could not resolve A/AAAA for %s', exchange.exchange);
                    return tryConnectMX();
                }

                let ipTry = -1;
                let tryConnectIP = retryConnection => {
                    if (!retryConnection && ipTry >= ipList.length - 1) {
                        return tryConnectMX();
                    }
                    let ip = retryConnection ? ipList[ipTry] : ipList[++ipTry];
                    let zoneAddress = zone.getAddress(delivery.id + '.' + delivery.seq, net.isIPv6(ip));
                    log.silly('Sender/' + zone.name + '/' + process.pid, 'Resolved MX for %s as %s[%s]. Using %s (%s[%s]) to connect', domain, exchange.exchange, ip, zone.name, zoneAddress.name, zoneAddress.address);

                    let options = {
                        servername: exchange.exchange,
                        host: ip,

                        port: zone.port,
                        localAddress: zoneAddress.address,
                        name: zoneAddress.name,

                        requireTLS: !zone.disableStarttls,
                        ignoreTLS: zone.disableStarttls,
                        opportunisticTLS: true,

                        tls: {
                            servername: exchange.exchange,
                            rejectUnauthorized: false
                        },
                        logger: ('logger' in zone ? zone.logger : config.log.mx) ? {
                            info: log.verbose.bind(log, 'Sender/' + zone.name + '/' + process.pid + '/SMTP'),
                            debug: log.silly.bind(log, 'Sender/' + zone.name + '/' + process.pid + '/SMTP'),
                            error: log.error.bind(log, 'Sender/' + zone.name + '/' + process.pid + '/SMTP')
                        } : false,
                        debug: ('logger' in zone ? zone.logger : config.log.mx)
                    };

                    connection = new SMTPConnection(options);
                    let returned = false;
                    let connected = false;

                    connection.once('error', err => {
                        connection.connected = false;
                        if (returned) {
                            return;
                        }
                        returned = true;
                        if (err.code === 'ETLS') {
                            // STARTTLS failed, try again, this time without encryption
                            log.info('Sender/' + zone.name + '/' + process.pid, 'Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext', exchange.exchange, ip);
                            zone.disableStarttls = true;
                            return tryConnectIP(true);
                        }
                        if (!connected) {
                            // try next host
                            if (mxTry >= exchanges.length) {
                                log.info('Sender/' + zone.name + '/' + process.pid, 'Failed to connect to %s[%s] for %s from %s (%s[%s])', exchange.exchange, ip, domain, zone.name, zoneAddress.name, zoneAddress.address);
                            }
                            return tryConnectIP();
                        }

                        log.error('Sender/' + zone.name + '/' + process.pid, 'Unexpected MX error');
                        log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                    });

                    connection.once('end', () => {
                        connection.connected = false;
                    });

                    connection.connect(() => {
                        connected = true;
                        connection.connected = true;
                        if (returned) {
                            return;
                        }
                        return callback(null, connection);
                    });
                };

                tryConnectIP();
            });
        };

        tryConnectMX();
    });
}

function formatSMTPResponse(str) {
    let code = str.match(/^\d{3}[\s\-]+([\d\.]+\s*)?/);
    return ((code ? code[0] : '') + (code ? str.substr(code[0].length) : str).replace(/^\d{3}[\s\-]+([\d\.]+\s*)?/mg, ' ')).replace(/\s+/g, ' ').trim();
}

function releaseDelivery(delivery, callback) {
    sendCommand({
        cmd: 'RELEASE',
        id: delivery.id,
        seq: delivery.seq,
        _lock: delivery._lock
    }, (err, updated) => {
        if (err) {
            return callback(err);
        }
        callback(null, updated);
    });
}

function deferDelivery(delivery, ttl, callback) {
    sendCommand({
        cmd: 'DEFER',
        id: delivery.id,
        seq: delivery.seq,
        _lock: delivery._lock,
        ttl
    }, (err, updated) => {
        if (err) {
            return callback(err);
        }
        callback(null, updated);
    });
}

function signMessage(delivery) {
    let dkimKeys;
    let headerFrom = delivery.headers.from && delivery.headers.from.split('@').pop();
    let envelopeFrom = delivery.from && delivery.from.split('@').pop();

    if (dkimSign.keys.has(headerFrom)) {
        dkimKeys = dkimSign.keys.get(headerFrom);
    } else if (dkimSign.keys.has(envelopeFrom)) {
        dkimKeys = dkimSign.keys.get(envelopeFrom);
    }

    let dkimHeader;
    if (dkimKeys) {
        dkimHeader = dkimSign.sign(delivery.headers, delivery.bodyHash, dkimKeys);
        delivery.dkim = true;
        delivery.headers.addFormatted('dkim-signature', dkimHeader);
    }
}

queueClient.connect(err => {
    if (err) {
        log.error('Sender/' + zone.name + '/' + process.pid, 'Could not connect to Queue server');
        log.error('Sender/' + zone.name + '/' + process.pid, err.message);
        process.exit(1);
    }

    queueClient.on('close', () => {
        if (!closing) {
            log.error('Sender/' + zone.name + '/' + process.pid, 'Connection to Queue server closed unexpectedly');
            process.exit(1);
        }
    });

    queueClient.onData = (data, next) => {
        let callback;
        if (responseHandlers.has(data.req)) {
            callback = responseHandlers.get(data.req);
            responseHandlers.delete(data.req);
            setImmediate(() => callback(data.error ? data.error : null, !data.error && data.response));
        }
        next();
    };

    // start sending instances
    for (let i = 0; i < zone.connections; i++) {
        // use artificial delay to lower the chance of races
        setTimeout(sender, Math.random() * 1500);
    }

});
