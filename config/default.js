'use strict';

module.exports = {
    // If started as root then privileges are dropped after all ports are bound
    //user: 'nobody',
    //group: 'nogroup',

    // App name to be used in the Received headers and greeting messages
    name: 'ZoneMTA',

    // App key for process name
    ident: 'zone-mta',

    dbs: {
        // database connection string
        mongo: 'mongodb://127.0.0.1:27017/zone-mta',
        redis: {
            host: '127.0.0.1',
            port: 6379,
            db: 3,
            connectTimeout: 10000
        },
        // optional database name if you want to use a different database than the connection string
        sender: 'zone-mta'
    },

    queue: {
        // for multi server setup use unique value for every instance
        // this is needed to route deferred messages to correct instance
        instanceId: 'default',

        // Collection name for GridFS storage
        gfs: 'mail',

        // Collection name for the queue
        collection: 'zone-queue',

        // set to true if you do not want old data to be removed
        disableGC: false
    },

    // plugin files to load into ZoneMTA, relative to ./plugins folder
    // use "core/{name}" to load built-in modules or "module/{name}" to load
    // modules installed from npm
    plugins: {
        'core/example-plugin': false,

        // Make sure messages have all required headers like Date or Message-ID
        'core/default-headers': {
            enabled: ['*'],

            // which interfaces to allow using routing headers like X-Sending-Zone
            allowRoutingHeaders: ['api', 'bounce'],

            // Add missing headers (Message-ID, Date, etc.)
            addMissing: ['message-id', 'date'],

            // If true then delay messages according to the Date header. Messages can be deferred up to 1 year.
            // This only works if the Date header is higher than 5 minutes from now because of possible clock skew
            // This should probably be a separate plugin
            futureDate: false,

            // add X-Originating-IP header
            xOriginatingIP: true
        },

        // If authentication is enabled (config.smtpInterfaces.feeder.authentication is true) then make a HTTP
        // request with Authorization:Basic header to the specified URL. If it succeeds (HTTP response code 200),
        // the the user is considered as authenticated
        'core/http-auth': {
            enabled: false, // 'receiver'
            url: 'http://localhost:12080/test-auth'
        },

        // Validate message dropped to the API
        'core/api-send': {
            enabled: false, // 'main'
            // How many recipients to allow per message when sending through the API
            maxRecipients: 100
        },

        // If enabled then checks message against a Rspamd server
        'core/rspamd': {
            enabled: false, // ['receiver', 'main', 'sender'], // spam is checked in 'receiver' context, headers are added in 'sender' context
            url: 'http://localhost:11333/check', // Rspamd API endpoint
            interfaces: ['feeder'], // use ['*'] to scan messages from all interfaces
            ignoreOrigins: [], // a list of source IP addresses to ignore spam results for
            maxSize: 5 * 1024 * 1024, // do not check for spam if the message is very large
            dropSpam: false, // if true then silently drop spam messages instead of rejecting
            rewriteSubject: false // if true adds a [**SPAM**] prefix to mail subject
            // ip: true // if true, then includes remote address in Rspamd input as the source IP
            // ip: '1.2.3.4' // if not true but a string, then includes this value in Rspamd input as the source IP
        },

        // Rewrite MAIL FROM address using SRS
        'core/srs': {
            enabled: false, // 'sender', // rewriting is handled in the sending phase
            // secret value for HHH hash
            secret: 'a cat',
            // which domain name to use for the rewritten addresses
            rewriteDomain: 'example.com',
            // which addresses to not rewrite (in addition to addresses for rewriteDomain)
            excludeDomains: ['blurdybloop.com']
        },

        // Send bounce message to the sender
        'core/email-bounce': {
            enabled: 'main',
            // From: address for the bounce emails
            mailerDaemon: {
                name: 'Mail Delivery Subsystem',
                // [HOSTNAME] will be replaced with the hostname that was used to send this message
                address: 'mailer-daemon@[HOSTNAME]'
            },
            sendingZone: 'bounces',
            zoneConfig: {
                // specify zone specific bounce options
                myzonename: {
                    // if true then ignore this block, revert to default
                    disabled: true,
                    // if not set then default mailerDaemon config is used
                    mailerDaemon: {
                        name: 'Mail Delivery Subsystem',
                        // [HOSTNAME] will be replaced with the hostname that was used to send this message
                        address: 'mailer-daemon@[HOSTNAME]'
                    },
                    // use same queue for handling bounces as for the original message
                    // if not set then default queue is used
                    sendingZone: 'myzonename'
                }
            }
        },

        // POST bounce data to a HTTP URL
        'core/http-bounce': {
            enabled: false, // 'main'
            // An url to send the bounce information to
            // Bounce notification would be a POST request with the following form fields:
            //   id=delivery id
            //   to=recipient address
            //   returnPath=envelope FROM address
            //   response=server response message
            //   fbl=the value from X-Fbl header
            // If bounce reporting fails (non 2xx response), the notification is retried a few times during the next minutes
            url: 'http://localhost:12080/report-bounce'
        },

        // Calculate and log md5 hashes for all image/* and application/* attachments. Attachment info with the hash
        // is added to the envelope object, so you can also screen messages against some specific attachments.
        // This adds some CPU load as attachments need to be decoded and md5 hashes,
        // so increase smtpInterfaces.*.processes count to handle the increased load
        // Example: 15872511b0d000c239 ATTACHMENT name="foto-02.jpg" type="image/jpeg" size=1922193 md5=6e0a1c5a2276f7afca68ec7ee4c3200c
        'core/image-hashes': false, // 'receiver',

        // Sign outbound messages with DKIM
        'core/dkim': {
            enabled: false, //'sender',
            // Domain name in the dkim signature. Leave blank to use the domain of From: address
            domain: 'example.com',
            // If true then uses the same key to add a signature for the hostname of the outbound IP address
            signTransportDomain: true,
            // Selector value in the dkim signature
            selector: 'test',
            // Key location
            path: '/path/to/private/key.pem'
        }
    },

    // You can define multiple listening SMTP interfaces, for example one for port 465, one for 587 etc
    smtpInterfaces: {
        // SMTP relay server that accepts messages for the outgoing queue
        feeder: {
            enabled: true,

            port: 2525,

            // how many processes to spawn
            processes: 2,

            // max message size in bytes
            maxSize: 30 * 1024 * 1024, // 30 MB

            // bind to localhost only
            host: '127.0.0.1',

            // Set to false to not require authentication
            // If authentication is enabled then you need to set up an authentication hook,
            // otherwise any username is considered as valid
            authentication: false,

            // if true then do not show version number in SMTP greeting message
            disableVersionString: false,

            // How many recipients to allow per message. This data is handled in batch,
            // so allowing too large lists of recipients might start blocking the thread.
            // 1000 or less recommended but can go up to tens of thousands if needed
            // (you do need to increase the allowed memory for the v8 when using huge recipient lists)
            maxRecipients: 1000,

            // set to true to see incoming SMTP transaction log
            logger: false,

            starttls: false, // set to true to enable STARTTLS (port 587)
            secure: false // set to true to start in TLS mode (port 465)
            /*
            // define keys for STARTTLS/TLS
            key: './keys/private.key',
            cert: './keys/server.crt'
            */

            /*
                // Additionally you can use the options listed in SMTPServer docs:
                // https://nodemailer.com/extras/smtp-server/#step-3-create-smtpserver-instance
                hideSTARTTLS: true,
                hide8BITMIME: true,
                useXClient: true,
                ...
             */
        }
    },

    dns: {
        // Cache lookup results in Redis. Set to false if using default DNS server
        caching: true,
        cahceTTL: 600, // ttl of cached dns keys in seconds (only applies if caching:true)

        // Sets DNS servers to use for resolving MX/A/AAAA records. If not set
        // then default nameservers are used. IP addresses only!
        //
        //nameservers: ['127.0.0.1'],
        //nameservers: ['8.8.8.8', '8.8.8.4'],
        //nameservers: ['1.1.1.1'],
        nameservers: false,

        // If true, then do not allow sending to MX servers in localhost or private IP range
        blockLocalAddresses: false
    },

    // Simple HTTP server for fetching info about messages
    api: {
        port: 12080,
        // bind to localhost only
        host: '127.0.0.1',
        // domain name to access the API server
        hostname: 'localhost',

        // if true, allow posting message data in Nodemailer format to /send
        maildrop: true,

        // hardcoded user credentials for the example authentication URL 'http://localhost:12080/test-auth'
        user: 'zone', // username for the static example auth url
        pass: 'test' // password for the static example auth url
    },

    // Data channel server for retrieving info about messages to be delivered
    queueServer: {
        // Set to false to disable any queue processing. Server would accept messages but would not send anything
        enabled: true,
        port: 12081,
        // bind to localhost only
        host: '127.0.0.1',
        // this is where the clients connect to
        hostname: 'localhost'
    },

    log: {
        // silly, verbose, info, error
        level: 'info',
        // set to true to see outgoing SMTP transaction log
        queue: false,
        remote: false
        /*
        // emit structured log information over UDP, this can be used by ZMTA Webadmin
        remote: {
           protocol: 'udp4',
           host: false,
           port: 31239
        }*/
    },

    // General DKIM settings
    dkim: {
        // If DKIM signing is turned on then body hash is calculated for every message,
        // even if there is no key available for this sender
        enabled: true,
        // Set default hash for the DKIM signature, eg. "sha1" or "sha256"
        hashAlgo: 'sha256'
    },

    uploads: {
        // if target is an URL then use the following User-Agent identifier
        userAgent: 'zone-mta'
    },

    pools: {
        default: [
            // You can set a list of interfaces here. If there are no IPv4 interfaces defined, then
            // a default interface of {address:'0.0.0.0', name: os.hostname()} is used
            /*

            // pool entry can be just an IPv4 or IPv6 address
            '1.2.3.4', // local address to bind to

            // for more specific settings, use the object form
            {
                // Local address to bind to
                address: '1.2.3.4',
                // Optional hostname to be used in EHLO/HELO commands, if not set then PTR of address is used
                name: 'mta.example.com',
                // Optional ratio value. A scale between 0 and 1, this indicates how much
                // of the load this ip should handle.
                // By default all messages are shared equally between different addresses
                ratio: 1 / 10
            }
             */
        ]
    },

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
            processes: 1,
            // How many parallel connections to open for this Sending Zone per process.
            // Local IP addresses from the pool are randomly distributed between
            // the connections.
            connections: 10,

            // Throttling applies per connection in a process
            // throttling: '100 messages/second', // max messages per minute, hour or second

            // Define address:name pairs (both IPv4 and IPv6) for outgoing IP addresses
            // This allows you to use different IP addresses for different messages:
            // For example, if you have 5 IP's listed and you open 5 parallel
            // connections against a domain then each of these seems to originate
            // from a different IP address (assuming you can locally bind to these addresses)
            pool: 'default'

            // Use next MTA instead of actual MX
            /*
            host: 'smtp.ethereal.email',
            port: 587,
            auth: {
                user: 'jzzluvyzi6hdb5r3@ethereal.email',
                pass: 'k6XGxbJc5h4Ny7PgtN'
            }
            */
        },

        // Sending Zone for sending bounce messages
        bounces: {
            preferIPv6: false,
            ignoreIPv6: true,
            connections: 1,
            processes: 1,
            // zone specific logging
            //logger: true,
            //logLevel: 'silly'

            // * send through next MTA instead of MX
            // port: 587,
            // host: 'smtp.gmail.com',
            // auth: { // optional
            //    user: 'username@gmail.com',
            //    pass: 'ssssss'
            //}
            pool: 'default'
        }
        /*
        loopback: {
            // Another example for a Sending Zone. You probably do not want to use this
            // unless you want all messages to be blocked
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

    blacklist: {
        // when an IP is blacklisted then disable using this ip for a domain for the next ttl ms
        // this is in memory only, so if you restart or reload the server the blacklist gets cleared
        ttl: 1 * 60 * 60 * 1000
    },

    // Domain specific configuration
    // Where "domain" means the domain part of an email address
    domainConfig: {
        // default is required
        default: {
            // How many parallel connections per Sending Zone to use against a recipient domain
            maxConnections: 5,
            // blacklisted IP addresses that should not be used to send mail to this specific server
            disabledAddresses: []
        }
        /*
        'test.tahvel.info': {
            maxConnections: 5
        },
        'hot.ee': {
            maxConnections: 5,
            disabledAddresses: ['127.0.0.1'],
            // domain specific DNS options that override zone and general DNS options
            dnsOptions: {
                preferIPv6: true,
                ignoreIPv6: false
            }
        }
        */
    },

    pluginsPath: './plugins'
};
