# ZoneMTA (internal code name X-699)

Modern outbound SMTP relay (MTA/MSA) built on Node.js and LevelDB.

> This is a **labs project** meaning that ZoneMTA is **not tested in production**. In the future it should replace our outbound Postfix servers but so far no actual mail servers have been deployed with ZoneMTA. Handle with care!

```
_____             _____ _____ _____
|__   |___ ___ ___|     |_   _|  _  |
|   __| . |   | -_| | | | | | |     |
|_____|___|_|_|___|_|_|_| |_| |__|__|
```

The goal of this project is to provide granular control over routing different messages. Trusted senders can be routed through high-speed (more connections) virtual "sending zones" that use high reputation IP addresses, less trusted senders can be routed through slower (less connections) virtual "sending zones" or through IP addresses with less reputation. In addition the server comes packed with features more common to commercial software, ie. message rewriting or HTTP API for posting messages.

ZoneMTA is comparable to [Haraka](https://haraka.github.io/) but unlike Haraka it's for outbound only. Both systems run on Node.js and have a built in plugin system even though the designs are somewhat different. The [plugin system](https://github.com/zone-eu/zone-mta/tree/master/plugins) (and a lot more as well) for ZoneMTA is inherited from the [Nodemailer](https://nodemailer.com/) project and thus do not have direct relations to Haraka.

## Quickstart

Assuming [Node.js](https://nodejs.org/en/download/package-manager/) (v6.0.0+), build tools and git. There must be nothing listening on ports 2525 (SMTP), 8080 (HTTP API) and 8081 (internal data channel). All these ports are configurable.

Run as any user (does not need to be root):

```bash
$ npm install -g zone-mta
$ zone-mta create path/to/app
$ zone-mta run -d path/to/app -c config.json
```

If everything succeeds then you should have a SMTP relay with no authentication running on localhost port 2525 (does not accept remote connections).

## Birds-eye-view of the system

### Incoming message pipeline

Messages are dropped for delivery either by SMTP or HTTP API. Message is processed as a stream, so it shouldn't matter if the message is very large in size (except if a very large message is submitted using the JSON API). This applies also to DKIM body hash calculation – the hash is calculated chunk by chunk as the message stream flows through (actual signature is generated out of the body hash when delivering the message to destination). The incoming stream starts from incoming connection and ends in LevelDB, so if there's an error in any step between these two, the error is reported back to the client and the message is rejected. If impartial data is stored to LevelDB it gets garbage collected after some time (all message bodies without referencing delivery rows are deleted automatically)

![](https://cldup.com/jepwxrWwXc.png)

### Outgoing message pipeline

Delivering messages to destination

![](https://cldup.com/9yEW3oNp3G.png)

## Features

- Cross platform. You do need compile tools but this should be fairly easy to set up on every platform, even on Windows
- Fast. Send millions of messages per day
- Send large messages with low overhead
- Automatic DKIM signing
- Adds Message-Id and Date headers if missing
- Sending Zone support: send different messages using different IP addresses
- Built-in support for delayed messages. Just use a future value in the Date header and the message is not sent out before that time
- Assign specific recipient domains to specific Sending Zones
- Queue is stored in LevelDB
- Built in IPv6 support
- Uses STARTTLS for outgoing messages by default, so no broken padlock images in Gmail
- Smarter bounce handling
- Throttling per Sending Zone connection
- Spam detection using Rspamd
- HTTP API to send messages
- Route messages to the onion network
- Custom [plugins](https://github.com/zone-eu/zone-mta/tree/master/plugins)

Check the [WIKI](https://github.com/zone-eu/zone-mta/wiki) for more details

## Setup

1. Requirements: Node.js v6+ for running the app + compiler for building LevelDB bindings
2. If running in Windows install the (free) build dependencies (Python, Visual Studio Build Tools etc). From elevated PowerShell (run as administrator) run `npm install --global --production windows-build-tools` to get these tools
3. Open ZoneMTA folder and install required dependencies: `npm install --production`
4. Modify configuration script (if you want to allow connections outside localhost make sure the feeder host is not bound to 127.0.0.1)
5. Run the server application: `node app.js`
6. If everything worked then you should have a relay SMTP server running at localhost:2525 (no authentication, no TLS. [Read here](https://github.com/zone-eu/zone-mta/wiki/Setting-up-TLS-or--STARTTLS) about setting up TLS if you do not want to use unencrypted connections and [here](https://github.com/zone-eu/zone-mta/wiki/Authenticating-users) about setting up authentication)
7. You can find the stats about queues at `http://hostname:8080/queue/default` where `default` is the default Sending Zone name. For other zones, replace the identifier in the URL. The queue counters are approximate.
8. If you want to scan outgoing messages for spam then you need to have a [Rspamd](https://rspamd.com/) server running

You can run the server using any user account. If you want to bind to a low port (eg. 587) you need to start out as _root_. Once the port is bound the user is downgraded to some other user defined in the config file (root privileges are not required once the server has started).

**NB!** The user the server process runs as must have write permissions for the LevelDB queue folder

### Configuration

Default configuration can be found from [default.js](config/default.js). Instead of changing values in that file you should create another config file that uses the name from NODE_ENV environment variable (defaults to 'development'). So for local development you should have a file called 'development.js' and in production 'production.js' in the same config folder. Values in these files override only the touched keys keeping everything else as by default.

For example if the default.js states an object with multiple properties like this:

```javascript
{
    mailerDaemon: {
        name: 'Mail Delivery Subsystem',
        address: 'mailer-daemon@' + os.hostname()
    }
}
```

Then you can override only a single property without changing the other values like this in development.js:

```
{
    mailerDaemon: {
        name: 'Override default value'
    }
}
```

### Install as a service

1. Move zone-mta folder to /opt/zone-mta
2. Ensure proper file permissions (server user must have write permissions for the queue folder)
3. Copy Systemd service file: `cp ./setup/zone-mta.service /etc/systemd/system/`
4. Enable Systemd service: `systemctl enable zone-mta.service`
5. Start the service: `service zone-mta start`
6. Send a message to application host port 2525 (no authentication, no TLS/STARTTLS)

## Features

### HTTP usage

All communication between ZoneMTA and your actual configuration server is handled over HTTP. For example when a user needs to be authenticated then ZoneMTA makes a HTTP request with user info to a provided HTTP address. If ZoneMTA wants to notify about a bounced message then a HTTP request is made. If ZoneMTA wants to check if an user can send messages another HTTP request is made etc. It also means that ZoneMTA does not have a built in user database, this is left entirely to your own application.

### Large message support

All data is processed in chunks without reading the entire message into memory, so it does not matter if the message is 1kB or 1GB in size.

### LevelDB backend

Using LeveldDB means that you do not run out of inodes when you have a large queue, you can pile up even millions of messages (assuming you do not run out of disk space first)

### DKIM signing

DKIM signing support is built in to ZoneMTA. If a new mail transaction is initiated a HTTP call is made against configuration server with the transaction info (includes MAIL FROM address, authenticated username and connection info). If the configuration server responds with DKIM keys (multiple keys allowed) then these keys are used to sign the outgoing message. See more [here](https://github.com/zone-eu/zone-mta/wiki/Handling-DKIM-keys)

### Sending Zone

You can define as many Sending Zones as you want. Every Sending Zone can have its own local address IP pool that is used to send out messages designated for that Zone (IP addresses are not locked, you can assign the same IP for multiple Zones or multiple times for a single Zone). You can also specify the amount of max parallel outgoing connections for a Sending Zone.

#### Routing by Zone name

To preselect a Zone to be used for a specific message you can use the `X-Sending-Zone` header key

```
X-Sending-Zone: zone-identifier
```

For example if you have a Sending Zone called "zone-identifier" set then messages with such header are routed through this Sending Zone.

#### Routing based on specific header value

You can define specific header values in the Sending Zone configuration with the `routingHeaders` option. For example if you want to send messages that contain the header 'X-User-ID' with value '123' then you can configure it like this:

```javascript
'sending-zone': {
    ...
    routingHeaders: {
        'x-user-id': '123'
    }
}
```

#### Routing based on sender domain name

You also define that all senders with a specific From domain name are routed through a specific domain. Use `senderDomains` option in the Zone config.

```javascript
'sending-zone': {
    ...
    senderDomains: ['example.com']
}
```

#### Routing based on recipient domain name

You also define that all recipients with a specific domain name are routed through a specific domain. Use `recipientDomains` option in the Zone config.

```javascript
'sending-zone': {
    ...
    recipientDomains: ['gmail.com', 'kreata.ee']
}
```

#### Default routing

The routing priority is the following:

1. By the `X-Sending-Zone` header
2. By matching `routingHeaders` headers
3. By sender domain value in `senderDomains`
4. By recipient domain value in `recipientDomains`

If no routing can be detected, then the "default" zone is used.

### IPv6 support

IPv6 is supported by default. You can disable it per Sending Zone if you don't need to or can't send messages over IPv6.

### HTTP based authentication

If authentication is required then all clients are authenticated against a HTTP endpoint using Basic access authentication. If the HTTP request succeeds then the user is considered as authenticated. See more [here](https://github.com/zone-eu/zone-mta/wiki/Authenticating-users)

### Per-Zone domain connection limits

You can set connection limits for recipient domains per Sending Zone. For example if you have set max 2 connections to a specific domain then even if your queue processor has free slots and there are a lot of messages queued for that domain it will not create more connections than allowed.

### Bounce handling

ZoneMTA tries to guess the reason behind rejecting a message – maybe the message was greylisted or maybe your sending IP is blocked by this recipient. Not every bounce is equal.

If the message hard bounces (or after too many retries for soft bounces) a bounce notification is POSTed to an URL. You can also define that a bounce response is sent to the sender email address. See more [here](https://github.com/zone-eu/zone-mta/wiki/Receiving-bounce-notifications)

### Error Recovery

ZoneMTA is an _at-least-once delivery_ system, so messages are deleted from the queue only after positive response from the receiving MX server. If a child starts processing a message the child locks the message and the lock is released automatically if the child dies or master dies. Once normal operations are resumed, the same message can be fetched from the queue again.

Child processes that handle actual delivery keep a TCP connection up against the master process. This connection is used as the data channel for exchanging information about deliveries. If the connection drops for any reason, all current operations are cancelled by the child and non-delivered messages are re-queued by the master. This behavior should limit the possibility of multiple deliveries of the same message. Multiple deliveries can still happen if the process or connection dies exactly on the moment when the MX server acknowledges the message and the notification does not get propagated to the master. This risk of multiple deliveries is preferred over losing messages completely.

Messages might get lost if the database gets into a corrupted state and it is not possible to recover data from it.

### HTTP API

You can post a JSON structure to a HTTP endpoint (if enabled) and it will be converted into a rfc822 formatted message and delivered to destination. The JSON structure follows Nodemailer email config (see [here](https://github.com/nodemailer/nodemailer#e-mail-message-fields)) except that file and url access is disabled – you can't define an attachment that loads its contents from a file path or from an url, you need to provide the file contents as base64 encoded string.

You can provide the authenticated username with `X-Authenticated-User` header and originating IP with `X-Originating-IP` header, both values are optional.

```bash
curl -H "Content-Type: application/json" -H "X-Authenticated-User: andris" -H "X-Originating-IP: 123.123.123.123" -X POST  http://localhost:8080/send -d '{
    "from": "sender@example.com",
    "to": "recipient1@example.com, recipient2@example.com",
    "subject": "hello",
    "text": "hello world!"
}'
```

#### Zone status

You can check the current state of a sending zone (for example "default") with the following query

```bash
curl http://localhost:8080/queue/default
```

The response includes counters about queued and deferred messages and also splits the counter by recipient domains

```json
{
    "time": "2016-10-03T13:12:18.128Z",
    "started": "2016-10-03T13:12:17.336Z",
    "processed": 1,
    "queued": 1,
    "deferred": 1,
    "domains": [{
        "domain": "example.com",
        "queued": 1,
        "deferred": 1
    }]
}
```

#### Message status in Queue

If you know the queue id (for example 1578a823de00009fbb) then you can check the current status with the following query

```bash
curl http://localhost:8080/message/1578a823de00009fbb
```

The response includes general information about the message and lists all recipients that are current queued (about to be sent) or deferred (are scheduled to send in the future). This does not include messages already sent or bounced.

```json
{
    "meta": {
        "id": "1578a823de00009fbb",
        "interface": "feeder",
        "from": "sender@example.com",
        "to": ["recipient1@example.com", "recipient2@example.com"],
        "origin": "127.0.0.1",
        "originhost": "[127.0.0.1]",
        "transhost": "foo",
        "transtype": "ESMTP",
        "time": 1475497588281,
        "dkim": {
            "hashAlgo": "sha256",
            "bodyHash": "HAuESLcsVfL2FGQCUtFOwTL6Ax18XDXZO2vOeAz+DpI="
        },
        "headers": [{
            "key": "date",
            "line": "Date: Mon, 03 Oct 2016 12:26:32 +0000"
        }, {
            "key": "from",
            "line": "From: Sender <sender@example.com>"
        }, {
            "key": "message-id",
            "line": "Message-ID: <95dc84ae-ff9e-4e95-aa75-8ee707bc018d@example.com>"
        }, {
            "key": "subject",
            "line": "subject: test"
        }],
        "messageId": "<95dc84ae-ff9e-4e95-aa75-8ee707bc018d@example.com>",
        "date": "Mon, 03 Oct 2016 12:26:32 +0000",
        "parsedEnvelope": {
            "from": "sender@example.com",
            "to": [],
            "cc": [],
            "bcc": [],
            "replyTo": false,
            "sender": false
        },
        "bodySize": 3458,
        "created": 1475497593204
    },
    "messages": [{
        "id": "1578a823de00009fbb",
        "seq": "002",
        "zone": "default",
        "recipient": "recipient1@example.com",
        "status": "DEFERRED",
        "deferred": {
            "first": 1475499253068,
            "count": 2,
            "last": 1475499774161,
            "next": 1475501274161,
            "response": "450 4.3.2 Service currently unavailable"
        }
    }]
}
```

## TODO

### 1\. Domain based throttling

Currently it is possible to limit active connections against a domain and you can limit sending speed per connection (eg. 10 messages/min per connection) but you can't limit sending speed per domain. If you have set 3 processes, 5 connections and limit sending with 10 messages / minute then what you actually get is 3 _5_ 10 = 150 messages per minute for a Sending Zone.

### 2\. Web interface

It should be possible to administer queues using an easy to use web interface.

### 3\. Replace LevelDB with RocksDB

RocksDB has much better performance both for reading and writing but it's more difficult to set up

## Notes

In production you probably would want to allow Node.js to use more memory, so you should probably start the app with `–max-old-space-size` option

```
node –max-old-space-size=8192 app.js
```

This is mostly needed if you want to allow large SMTP envelopes on submission (eg. someone wants to send mail to 10 000 recipients at once) as all recipient data is gathered in memory and copied around before storing to the queue.

## Potential issues

ZoneMTA uses LevelDB as the storage backend. While extremely capable and fast there is a small chance that LevelDB gets into a corrupted state. There are options to recover from such state automatically but this usually means dropping a lot of data, so no automatic attempt is made to "fix" the corrupt database by the application. What you probably want to do in such situation would be to move the queue folder to some other location for manual recovery and let ZoneMTA to start over with a fresh and empty queue folder.

If LevelDB is in a corrupt state then no messages are accepted for delivery. A positive response is sent to the client only after the entire contents of the message to send are processed and successfully stored to disk.

## License

European Union Public License 1.1 ([details](http://ec.europa.eu/idabc/eupl.html))

In general, EUPLv1.1 is compatible with GPLv2, so it's a _copyleft_ license. Unlike GPL the EUPL license has legally binding translations in every official language of the European Union, including the Estonian language. This is why it was preferred over GPL.
