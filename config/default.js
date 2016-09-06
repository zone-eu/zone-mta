'use strict';

const os = require('os');

module.exports = {

    // If started as root then privileges are dropped after all ports are bound
    // This user must have read+write rights for the leveldb folder
    user: 'nobody',
    group: 'nogroup',

    // App name to be used in the Received headers
    name: 'ZoneMTA',

    mailerDaemon: {
        name: 'Mail Delivery Subsystem',
        address: 'mailer-daemon@' + os.hostname()
    },

    // The user running this server mush have read/write access to the following folders
    queue: {
        // Leveldb folder location. Created if it does not exist
        db: './data/queue'
    },

    // SMTP relay server that accepts messages for the outgoing queue
    feeder: {
        port: 2525,

        // bind to localhost only
        host: '127.0.0.1',

        // Set to false to not require authentication
        authentication: false,

        // ZoneMTA makes an Authentication:Basic request against that url
        // and if the response is positive (in the 2xx range), then then user
        // is considered as authenticated
        // The test auth url authenticates users as zone:test
        // Use "AUTH PLAIN em9uZQB6b25lAHRlc3Q=" for telnet
        authUrl: 'http://localhost:8080/test-auth',
        user: 'zone', // username for the static example auth url
        pass: 'test', // password for the static example auth url

        // if true then do not show version number in SMTP greeting message
        disableVersionString: false,

        starttls: false, // set to true to enable STARTTLS (port 587)
        secure: false // set to true to start in TLS mode (port 465)
            /*
            // define keys for STARTTLS/TLS
            key: './keys/private.key',
            cert: './keys/server.crt'
            */
    },

    rspamd: {
        enabled: false,
        url: 'http://localhost:11333/check',
        rejectSpam: true
    },

    rewrite: {
        // If enabled then posts all text/html nodes to an URL and replaces
        // node contents with the response. Use it to add tracking links etc.
        enabled: false,
        // This url should respond with a JSON: {"html": "<html> contents as unicode string"}
        url: 'http://localhost:8080/rewrite'
    },

    srs: {
        enabled: false,
        // secret value for HHH hash
        secret: 'a cat',
        // which domain name to use for the rewritten addresses
        rewriteDomain: 'kreata.ee',
        // which addresses to not rewrite
        excludeDomains: ['kreata.ee']
    },

    // Sets DNS servers to use for resolving MX/A/AAAA records
    // Use only IP addresses
    //nameservers: ['127.0.0.1']

    // Simple HTTP server for fetching info about messages
    api: {
        port: 8080,
        // bind to localhost only
        host: '127.0.0.1',
        // domain name to access the API server
        hostname: 'localhost',

        // if true, allow posting message data in Nodemailer format to /send
        maildrop: true
    },

    // Data channel server for retrieving info about messages to be delivered
    queueServer: {
        port: 8081,
        // bind to localhost only
        host: '127.0.0.1',
        // this is where the clients connect to
        hostname: 'localhost'
    },

    log: {
        // silly, verbose, info, error
        level: 'info',
        // set to true to see outgoing SMTP transaction log
        mx: false,
        // set to true to see incoming SMTP transaction log
        feeder: false
    },

    bounces: {
        // Set to true if you want to send a bounce email to sender
        enabled: true,

        // An url to send the bounce information to. Set to false if you do not want to send notifications.
        // Bounce notification would be a POST request with the following form fields:
        //   id=delivery id
        //   to=recipient address
        //   returnPath=envelope FROM address
        //   response=server response message
        //   fbl=the value from X-Fbl header
        // If bounce reporting fails (non 2xx response), the notification is retried a few times during the next minutes
        url: 'http://localhost:8080/report-bounce'
    },

    /*
        DKIM keys are provided by sender config response.

        Defualt DKIM private keys are stored in ./keys as {DOMAIN}.{SELECTOR}.pem

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
        // Set default hash for the DKIM signature, eg. "sha1" or "sha256". This can be
        // overriden by
        hashAlgo: 'sha256',
        // Key folder for the default keys
        keys: './keys'
    },

    // How many recipients to allow per message. This data is handled in batch,
    // so allowing too large lists of recipients might start blocking the thread.
    // 1000 or less recommended but can go up to tens of thousands if needed
    // (you do need to increase the allowed memory for the v8 when using huge recipient lists)
    maxRecipients: 1000,

    // If true then delay messages according to the Date header. Messages can be deferred up to 1 year.
    // This only works if the Date header is higher than 5 minutes from now because of possible clock skew
    allowFutureMessages: false,

    // An URL to check sender configuration from. Set to false if you do not want to use sender specific config
    getSenderConfig: 'http://localhost:8080/get-config',

    // Sending Zone definitions
    // Every Sending Zone can have multiple IPs that are rotated between connections
    zones: {
        // example default zone
        default: {
            // you can override the SMTP port for testing
            //port: 25,

            // If true then tries IPv6 addresses first when connecting to MX
            preferIPv6: false,

            // If true then does not resolve IPv6 addresses even if these exist.
            // Use it if you can not use IPv6
            ignoreIPv6: true,

            // How many child processes to run for this zone
            processes: 2,
            // How many parallel connections to open for this Sending Zone per process.
            // Local IP addresses from the pool are randomly distributed between
            // the connections.
            connections: 5,

            // Throttling applies per connection in a process
            throttling: '100 messages/second', // max messages per minute, hour or second

            // Define address:name pairs (both IPv4 and IPv6) for outgoing IP addresses
            // This allows you to use different IP addresses for different messages:
            // For example, if you have 5 IP's listed and you open 5 parallel
            // connections against a domain then each of these seems to originate
            // from a different IP address (assuming you can locally bind to these addresses)
            pool: [{
                address: '0.0.0.0',
                name: os.hostname()
            }, {
                address: '::',
                name: os.hostname()
            }]
        },
        // Sending Zone for sending bounce messages
        bounces: {
            preferIPv6: true,
            ignoreIPv6: false,
            connections: 1,
            processes: 1,
            // zone specific logging
            logger: true,
            logLevel: 'silly'
        }
        /*
        loopback: {
            // Another example for a Sending Zone. You probably do not want to use this
            // unless you want all messages to be blocked
            name: 'loopback',
            port: 25,
            preferIPv6: false,
            ignoreIPv6: true,
            connections: 1,
            processes: 1,
            // use all IP addresses provided by this network interface
            interface: 'lo0',
            // All messages that are sent from @localhost addresses are routed through
            // this Sending Zone by default
            senderDomains: ['localhost']
        },
        gmail: {
            port: 25,
            preferIPv6: true,
            ignoreIPv6: false,
            connections: 1,
            processes: 1,
            // zone specific logging
            logger: true,
            logLevel: 'silly',
            // If zone is not specified then use this zone as default for the following recipient domains
            recipientDomains: ['gmail.com', 'kreata.ee'],
            routingHeaders: {
                // use this zone by default if the message includes the following header
                'x-user-id': '123'
            }
        }
        */
    },

    // Domain specific configuration
    // Where "domain" means the domain part of an email address
    domainConfig: {
        // default is required
        default: {
            // How many parallel connections per Sending Zone to use against a recipient domain
            maxConnections: 5
        }
        /*
        'test.tahvel.info': {
            maxConnections: 5
        },
        'hot.ee': {
            maxConnections: 5
        }
        */
    }
};
