'use strict';

const os = require('os');
// const fs = require('fs');

module.exports = {

    // If started as root then privileges are dropped after all ports are bound
    // This user must have read+write rights for the leveldb folder and appendlog folder
    user: 'nobody',
    group: 'nogroup',

    // SMTP relay server that accepts messages for the outgoing queue
    feeder: {
        port: 2525,
        // bind to localhost only
        host: '127.0.0.1',

        // Set to false to not require authentication
        authentication: true,
        // Zone-MTA makes an Authentication:Basic request against that url
        // and if the response is positive (in the 2xx range), then then user
        // is considered as authenticated
        // The test auth url authenticates users as zone:test
        authurl: 'http://localhost:8080/test-auth',
        user: 'zone', // username for the static example auth url
        pass: 'test', // password for the static example auth url

        // how many RCPT TO calls allowed per message
        maxRecipients: 500,

        starttls: false, // set to true to enable STARTTLS (port 587)
        secure: false // set to true to start in TLS mode (port 465)
            /*
            // define keys for STARTTLS/TLS
            key: fs.readFileSync('../keys/private.key'),
            cert: fs.readFileSync('../keys/server.crt')
            */
    },

    // Sets DNS servers to use for resolving MX/A/AAAA records
    // Use only IP addresses
    //nameservers: ['127.0.0.1']

    // Simple HTTP server for fetching info about messages
    api: {
        port: 8080,
        // bind to localhost only as the server does authenticate users
        host: '0.0.0.0',
        // domain name to access the API server
        hostname: 'localhost'
    },

    queue: {
        // Leveldb folder location. Created if it does not exist
        db: './queuedata',
        // crash recovery log files folder. Created if it does not exist
        appendlog: './appendlog'
    },

    log: {
        // silly, verbose, info, error
        level: 'info',
        // set to true to see outgoing SMTP transaction log
        mx: false,
        // set to true to see incoming SMTP transaction log
        feeder: false
    },

    /*
        DKIM private keys are stored in ./keys as {DOMAIN}.{SELECTOR}.pem

        For example if you want to use a key for "kreata.ee" with selector "test" then
        the private.key should be available from ./keys/kreata.ee.test.pem

        DKIM signature is based on the domain name of the From: address or if there
        is no From: address then by the domain name of the envelope MAIL FROM:.
        If a matching key can not be found then the message is not signed
     */
    dkim: {
        // If DKIM signing is turned on then body hash is calculated for every message,
        // even if there is no key available for this sender
        enabled: true,
        // Set hash for the DKIM signature, eg. "sha1" or "sha256"
        hash: 'sha256'
    },

    // Sending Zone definitions
    // Every Sending Zone can have multiple IPs that are rotated between connections
    zones: [{
        // Identifier for the Sending Zone
        // 'default' is a special ID that always exists even if not defined
        // If a zone is not selected for a message, then 'default' is used
        name: 'default',
        port: 25,
        // If true then tries IPv6 addresses first when connecting to MX
        preferIPv6: true,
        // If true then does not resolve IPv6 addresses even if these exist.
        // Use it if you can not use IPv6
        ignoreIPv6: false,
        // how many child processes to run for this zone
        processes: 4,
        // How many parallel connections to open for this Sending Zone per process.
        // Local IP addresses from the pool are randomly distributed between
        // the connections.
        connections: 10,

        // Throttling applies per connection in a process
        throttling: '100 messages / second', // max messages per minute, hour or second

        // Define address:name pairs (both IPv4 and IPv6) for outgoing IP addresses
        // This allows you to use different IP addresses for different messages:
        // For example, if you have 5 IP's listed and you open 5 parallel
        // connections against a domain then each of these seems to originate
        // from a different IP address (assuming you can bind to these addresses)
        pool: [{
            address: '0.0.0.0',
            name: os.hostname()
        }, {
            address: '::',
            name: os.hostname()
        }]
    }, {
        // Another example for a Sending Zone. You probably do not want to use this
        // unless you want all messages to be blocked
        name: 'loopback',
        port: 25,
        preferIPv6: false,
        ignoreIPv6: true,
        connections: 1,
        processes: 1,
        interface: 'lo0', // use all IP addresses provided by this network interface
        // All messages that are send from @localhost addresses are routed through
        // this Sending Zone by default
        senderDomains: ['localhost']
    }, {
        name: 'gmail',
        port: 25,
        preferIPv6: true,
        ignoreIPv6: false,
        connections: 1,
        processes: 1,
        // zone specific logging
        logger: true,
        logLevel: 'silly',
        // If zone is not specified then use this zone as default for the following recipient domains
        recipientDomains: ['gmail.com', 'kreata.ee']
    }],

    // Domain specific configuration
    domainConfig: {
        // default is required
        default: {
            maxConnections: 5
        },

        'test.tahvel.info': {
            maxConnections: 5
        }
    }
};
