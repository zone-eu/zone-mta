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
const mkdirp = require('mkdirp');
const PassThrough = require('stream').PassThrough;
const AppendLog = require('./lib/append-log');
const dkimSign = require('./lib/dkim-sign');
const SRS = require('srs.js');
const srsRewriter = new SRS({
    secret: config.srs.secret
});

let closing = false;
let zone;

// Read command line arguments
let currentZone = (process.argv[2] || '').toString().trim().toLowerCase();
let instanceId = (process.argv[3] || '').toString().trim().toLowerCase();
let clientId = (process.argv[4] || '').toString().trim().toLowerCase() || crypto.randomBytes(10).toString('hex');

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

let unacker = new AppendLog({
    fnamePrefix: 'unacked-' + clientId + '.' + currentZone + '.' + process.pid,
    folder: config.queue.appendlog,
    logId: 'Sender/' + zone.name + '/' + process.pid
});

function fetchJson(url, options, callback) {
    if (!callback && typeof options === 'function') {
        callback = options;
        options = false;
    }

    let retries = 0;

    let tryRequest = () => {

        let chunks = [];
        let chunklen = 0;
        let returned = false;
        let req = fetch(url, options);

        req.on('readable', () => {
            let chunk;
            while ((chunk = req.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        });

        req.on('error', err => {
            if (!closing && retries < 5 && err && err.code && /^ECONN/.test(err.code)) {
                let sec = Math.min(Math.pow(2, retries++), 16); // check again in  2, 4, 8, 16 seconds
                log.verbose('Sender/' + zone.name + '/' + process.pid, 'Request to "%s" failed, retrying in %s sec.', url, sec);
                return setTimeout(tryRequest, sec * 1000);
            }
            if (returned) {
                return false;
            }
            returned = true;
            callback(err);
        });

        req.on('end', () => {
            if (returned) {
                return false;
            }
            returned = true;
            let data;
            try {
                data = JSON.parse(Buffer.concat(chunks, chunklen));
            } catch (E) {
                return callback(new Error('Could not parse JSON'));
            }
            callback(null, data);
        });
    };

    tryRequest();
}

function sender() {
    let ref = {}; // we need a new object value for WeakMap references
    let sendNext = () => {
        if (closing) {
            return;
        }

        fetchJson('http://' + config.api.hostname + ':' + config.api.port + '/get/' + instanceId + '/' + clientId + '/' + zone.name, (err, delivery) => {
            if (err) {
                closing = true;
                log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                return;
            }

            if (!delivery || !delivery.id) {
                return setTimeout(sendNext, 5 * 1000);
            }
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
                    let messageFetch = fetch('http://' + config.api.hostname + ':' + config.api.port + '/fetch/' + instanceId + '/' + clientId + '/' + delivery.id);
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

                        // Mark as sent but not yet acknowledged
                        unacker.add(delivery.id + '.' + delivery.seq);

                        log.info('Sender/' + zone.name + '/' + process.pid, 'ACCEPTED %s.%s for <%s> by %s (%s)', delivery.id, delivery.seq, delivery.to, delivery.domain, formatSMTPResponse(info.response));
                        return releaseDelivery(delivery, err => {
                            if (err) {
                                log.error('Sender/' + zone.name + '/' + process.pid, 'Can\'t get message acknowledged');
                                log.error('Sender/' + zone.name + '/' + process.pid, err.message);
                                closing = true;
                                return;
                            }
                            // Acknowledging worked, remove the entry from log file
                            unacker.remove(delivery.id + '.' + delivery.seq);

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
    fetchJson('http://' + config.api.hostname + ':' + config.api.port + '/release-delivery/' + instanceId + '/' + clientId + '/' + zone.name, {
        method: 'POST',
        body: JSON.stringify({
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock
        }),
        contentType: 'application/json; charset=utf-8'
    }, (err, updated) => {
        if (err) {
            return callback(err);
        }
        callback(null, updated);
    });
}

function deferDelivery(delivery, ttl, callback) {
    fetchJson('http://' + config.api.hostname + ':' + config.api.port + '/defer-delivery/' + instanceId + '/' + clientId + '/' + zone.name, {
        method: 'POST',
        body: JSON.stringify({
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock,
            ttl
        }),
        contentType: 'application/json; charset=utf-8'
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

// Start by ensuring the appendlog folder exists
mkdirp(config.queue.appendlog, err => {
    if (err) {
        log.error('Sender/' + zone.name + '/' + process.pid, 'Could not create appendlog folder');
        log.error('Sender/' + zone.name + '/' + process.pid, err.message);
        return process.exit(1);
    }

    // start sending instances
    for (let i = 0; i < zone.connections; i++) {
        // use artificial delay to lower the chance of races
        setTimeout(sender, Math.random() * 1500);
    }
});
