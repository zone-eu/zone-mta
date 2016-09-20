'use strict';

const Socks = require('socks');

// This module allows sending mail to the Onion network
// If enabled then messages to *.onion addresses are not sent using normal connections
// but through a SOCKS5 proxy

module.exports.title = 'Onion routing';
module.exports.init = function (app, done) {

    // We use a WeakSet structure to store references for deliveries that should be routed to the onion network
    // So instead of checking in every hook if the recipient address ends with .onion we check if the delivery
    // is added to the Set or not. If the delivery gets cancelled we do not care about it as
    // it's a WeakSet, so the value gets garbage collected automatically
    let deliveries = new WeakSet();

    // If the recipient email is targeted to an onion address, store a reference of this delivery
    // and set exchange against localhost. This prevents resolving the IP for the MX host
    app.addHook('sender:mx', (delivery, exchanges, next) => {
        if ((delivery.recipient || '').substr(-6) === '.onion') {
            // push fake entry with an IP to prevent any actual resolving
            exchanges.push({
                exchange: '127.0.0.1',
                priority: 0
            });
            // store delivery to a weak map
            deliveries.add(delivery);
        }
        next();
    });

    // When connecting to recipient MX and the message is addressed to an onion address,
    // create a SOCKS5 connection to a TOR proxy and force using this proxied connection
    app.addHook('sender:connect', (delivery, connectionOptions, next) => {
        if (!deliveries.has(delivery)) {
            // normal connection
            return next();
        }

        // use SOCKS5 procy to connect to the onion network
        let host = delivery.recipient.substr(delivery.recipient.lastIndexOf('@') + 1);
        Socks.createConnection({
            proxy: {
                ipaddress: app.config.host || '127.0.0.1',
                port: app.config.port || 9150,
                type: 5
            },
            target: {
                host,
                port: app.config.mtaPort || 25
            },
            command: 'connect',
            authentication: app.config.auth
        }, (err, socket) => {
            if (err) {
                return next(err);
            }

            // Set the service name for the EHLO call
            if ((delivery.from || '').substr(-6) === '.onion') {
                connectionOptions.name = delivery.from.substr(delivery.from.lastIndexOf('@') + 1);
            } else {
                connectionOptions.name = app.config.name || 'localhost';
            }

            // useful if receiving host provides a valid TLS certificate
            connectionOptions.servername = host;

            // instead of connecting to a host, use the provided socket from socks proxy
            connectionOptions.connection = socket;

            return next();
        });
    });

    // When sending messages to the onion network we probably want to keep the provided
    // information as low as possible, so this hook removes all headers that are not required
    app.addHook('sender:headers', (delivery, next) => {
        if (!deliveries.has(delivery)) {
            // normal connection
            return next();
        }

        // remove all but the most minimally required header keys when sending to Onion network
        let allowedKeys = ['content-type', 'content-transfer-encoding', 'from', 'to', 'cc', 'subject', 'message-id', 'in-reply-to', 'date', 'mime-version'];
        let keys = delivery.headers.getList().map(line => line.key);
        let checked = new Set();
        keys.forEach(key => {
            if (checked.has(key)) {
                return;
            }
            checked.add(key);
            if (!allowedKeys.includes(key)) {
                delivery.headers.remove(key);
            }
        });

        next();
    });

    done();
};
