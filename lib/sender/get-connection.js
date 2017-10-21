'use strict';

const net = require('net');
const netErrors = require('./net-errors');
const plugins = require('../plugins');

const MAX_CONNECT_TIME = 5 * 60 * 1000;

function getConnection(delivery) {
    // try through different IP addresses to get a connection to the MX port

    return new Promise((resolve, reject) => {
        // serialize available addresses
        let mxHosts = [];
        let mxHostsSeen = new Set();
        delivery.mx.forEach(mx => {
            mx.A.forEach(a => {
                if (mxHostsSeen.has(a)) {
                    return;
                }
                mxHostsSeen.add(a);

                mxHosts.push({
                    hostname: mx.exchange,
                    priority: mx.priority,
                    ipv4: true,
                    host: a,
                    isMX: mx.mx
                });
            });
            mx.AAAA.forEach(aaaa => {
                if (mxHostsSeen.has(aaaa)) {
                    return;
                }
                mxHostsSeen.add(aaaa);

                mxHosts.push({
                    hostname: mx.exchange,
                    priority: mx.priority,
                    ipv6: true,
                    host: aaaa,
                    isMX: mx.mx
                });
            });
        });

        if (!mxHosts.length) {
            let err = new Error('Could not find any MX servers for ' + delivery.domain);
            err.response = '550 ' + err.message;
            err.category = 'dns';
            return reject(err);
        }

        if (delivery.dnsOptions.preferIPv6) {
            mxHosts = mxHosts.sort((a, b) => {
                if (a.ipv6) {
                    return -1;
                }
                if (b.ipv6) {
                    return 1;
                }
                return 0;
            });
        }

        if (mxHosts.length > 20) {
            // keep the length of the hosts to check in reasonable length as there
            // are hosts with hundreds of unresponsive MX entries
            mxHosts = mxHosts.slice(0, 20);
        }

        let firstError = false;
        let tried = 0;
        let tryNextMX = () => {
            if (tried >= mxHosts.length) {
                let err = firstError || new Error('Could not connect to any of the MX servers for ' + delivery.domain);
                err.response = err.response || '450 ' + err.message;
                err.category = err.category || 'network';
                return reject(err);
            }

            let mx = mxHosts[tried++];

            let connected = false;
            let connectTimeout = false;

            delivery.zoneAddress = delivery.zoneAddress || (net.isIPv6(mx.host) ? delivery.zoneAddressIPv6 : delivery.zoneAddressIPv4);
            let options = {
                port: delivery.mxPort || 25,
                host: mx.host
            };

            if (delivery.zoneAddress.address !== mx.host) {
                options.localAddress = delivery.zoneAddress.address;
            }

            plugins.handler.runHooks('sender:connect', [delivery, options], err => {
                if (err) {
                    return reject(err);
                }

                if (options.socket) {
                    mx.socket = options.socket;
                    return resolve(mx);
                }

                let socket = net.connect(options, () => {
                    clearTimeout(connectTimeout);
                    if (connected) {
                        // something already happened, just skip this connection and hope for the best
                        return socket.end();
                    }
                    connected = true;
                    // we have a connection!
                    mx.socket = socket;
                    options.localAddress = socket.localAddress;
                    options.remoteAddress = socket.remoteAddress;
                    return resolve(mx);
                });
                socket.once('error', err => {
                    if (err && !firstError) {
                        let code = mx.isMX ? 450 : 550;
                        err.message = `Network error when connecting to MX server ${mx.hostname}[${mx.host}] for ${delivery.domain}: ${netErrors[err.code] ||
                            netErrors[err.errno] ||
                            err.message}`;
                        err.response = err.response || code + ' ' + err.message;
                        err.category = err.category || 'network';
                        firstError = err;
                    }
                    clearTimeout(connectTimeout);
                    if (!connected) {
                        connected = true;
                        return setImmediate(tryNextMX);
                    }
                });
                connectTimeout = setTimeout(() => {
                    // most probably we never hit this timer, it's a safety net for strange connections
                    clearTimeout(connectTimeout);
                    if (!connected) {
                        connected = true;
                        if (!firstError) {
                            let code = mx.isMX ? 450 : 550;
                            firstError = new Error(`Connection timed out when connecting to MX server ${mx.hostname}[${mx.host}] for ${delivery.domain}`);
                            firstError.response = code + ' ' + firstError.message;
                            firstError.category = 'network';
                        }
                        return setImmediate(tryNextMX);
                    }
                }, MAX_CONNECT_TIME);
            });
        };

        setImmediate(tryNextMX);
    });
}

module.exports = getConnection;
