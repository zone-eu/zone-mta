# ZoneMTA (internal code name X-699)

Modern outbound SMTP relay (MTA/MSA) built on Node.js and MongoDB (queue storage). It's kind of like Postfix for outbound but is able to use multiple local IP addresses and is easily extendable using plugins that are way more flexible than milters.

> Currently there's a single ZoneMTA instance deployed to production, it delivers about 500 000 messages per day, processing 70-80 messages per second on peak times. Total messages successfully delivered by that server is more than 100 000 000 (plus 3 000 000 emails that have bounced).

```
███████╗ ██████╗ ███╗   ██╗███████╗███╗   ███╗████████╗ █████╗
╚══███╔╝██╔═══██╗████╗  ██║██╔════╝████╗ ████║╚══██╔══╝██╔══██╗
  ███╔╝ ██║   ██║██╔██╗ ██║█████╗  ██╔████╔██║   ██║   ███████║
 ███╔╝  ██║   ██║██║╚██╗██║██╔══╝  ██║╚██╔╝██║   ██║   ██╔══██║
███████╗╚██████╔╝██║ ╚████║███████╗██║ ╚═╝ ██║   ██║   ██║  ██║
╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝   ╚═╝   ╚═╝  ╚═╝
```

ZoneMTA provides granular control over routing different messages. Trusted senders can be routed through high-speed (more parallel connections) virtual "sending zones" that use high reputation IP addresses, less trusted senders can be routed through slower (less connections) virtual "sending zones" or through IP addresses with less reputation. In addition the server comes packed with features more common to commercial software, ie. message rewriting, IP warm-up or HTTP API for posting messages.

ZoneMTA is comparable to [Haraka](https://haraka.github.io/) but unlike Haraka it's for outbound only. Both systems run on Node.js and have a built in plugin system even though the designs are somewhat different. The [plugin system](https://github.com/zone-eu/zone-mta/tree/master/plugins) (and a lot more as well) for ZoneMTA is inherited from the [Nodemailer](https://nodemailer.com/) project and thus do not have direct relations to Haraka.

There's also a web-based [administration interface](https://github.com/zone-eu/zmta-webadmin) (needs to be installed separately).

## Upgrade notes

ZoneMTA version 1.1 uses a different application configuration scheme than 1.0. See [zone-mta-template](https://github.com/zone-eu/zone-mta-template) for reference.

Also, there is no zone-mta command line application anymore, you need to include it as a module.

## Requirements

1.  **Node.js** v6.0.0+ for running the app
2.  **MongoDB** for storing messages in the queue
3.  **Redis** for locking and counters

## Quickstart

Assuming [Node.js](https://nodejs.org/en/download/package-manager/) (v6.0.0+), _MongoDB_ running on localhost and _git_. There must be nothing listening on ports 2525 (SMTP), 12080 (HTTP API) and 12081 (internal data channel). All these ports are configurable.

#### Create ZoneMTA application

Fetch the ZoneMTA application template

```
$ git clone git://github.com/zone-eu/zone-mta-template.git
$ cd zone-mta-template
$ npm install --production
$ npm start
```

If everything succeeds then you should have a SMTP relay with no authentication running on localhost port 2525 (does not accept remote connections).

Next you could try to install and configure an additional plugin or edit the default configuration in the config folder.

Web administration console should be installed separately, it is not part of the default installation. See instructions in the [ZMTA-WebAdmin page](https://github.com/zone-eu/zmta-webadmin).

## Birds-eye-view of the system

### Incoming message pipeline

Messages are dropped for delivery either by SMTP or HTTP API. Message is processed as a stream, so it shouldn't matter if the message is very large in size (except if a very large message is submitted using the JSON API). This applies also to DKIM body hash calculation – the hash is calculated chunk by chunk as the message stream flows through (actual signature is generated out of the body hash when delivering the message to destination). The incoming stream starts from incoming connection and ends in MongoDB GridFS, so if there's an error in any step between these two, the error is reported back to the client and the message is rejected. If impartial data is stored to GridFS it gets garbage collected after some time (all message bodies without referencing delivery rows are deleted automatically)

![](https://cldup.com/jepwxrWwXc.png)

### Outgoing message pipeline

Delivering messages to destination (this image is outdated, LevelDB is not used anymore)

![](https://cldup.com/9yEW3oNp3G.png)

## Features

*   Web interface. See queue status and debug deferred messages through an easy to use [web interface](https://github.com/zone-eu/zmta-webadmin) (needs to be installed separately).
*   Cross platform. You can run ZoneMTA even on Windows
*   Fast. Send millions of messages per day
*   Send large messages with low overhead
*   Automatic DKIM signing
*   Adds _Message-Id_ and _Date_ headers if missing
*   Sending Zone support: send different messages using different IP addresses
*   Built-in support for delayed messages. Just use a future value in the Date header and the message is not sent out before that time
*   Assign specific recipient domains to specific Sending Zones
*   Queue is stored in MongoDB
*   Built in IPv6 support
*   Reports to Prometheus
*   Uses STARTTLS for outgoing messages by default, so no broken padlock images in Gmail
*   Smarter bounce handling
*   Throttling per Sending Zone connection
*   Spam detection using Rspamd
*   HTTP API to send messages
*   Custom [plugins](https://github.com/zone-eu/zone-mta/tree/master/plugins)
*   Automatic back-off if an IP address gets blacklisted
*   Email Address Internationalization ([EAI](https://datatracker.ietf.org/wg/eai/about/)) and SMTPUTF8 extension. Send mail to unicode addresses like _андрис@уайлддак.орг_
*   Delivery to HTTP using POST instead of SMTP

Check the [WIKI](https://github.com/zone-eu/zone-mta/wiki) for more details

### Configuration

Default configuration can be found from [default.js](config/default.js). You can override options in your application specific configuration but you do not need to specify these values that you want to keep as default.

## Features

### Large message support

All data is processed in chunks without reading the entire message into memory, so it does not matter if the message is 1kB or 1GB in size.

### DKIM signing

DKIM signing support is built in to ZoneMTA. You can provide DKIM keys using the built in DKIM plugin (see [here](https://github.com/zone-eu/zone-mta/wiki/Handling-DKIM-keys)) or alternatively create your own plugin to handle key management. ZoneMTA calculates all required hashes and is able to sign messages if a key or multiple keys are provided.

### Sending Zone

You can define as many Sending Zones as you want. Every Sending Zone can have its own local address IP pool that is used to send out messages designated for that Zone (IP addresses are not locked, you can assign the same IP for multiple Zones or multiple times for a single Zone). You can also specify the amount of maximum parallel outgoing connections (per process) for a Sending Zone.

#### Routing by Zone name

To preselect a Zone to be used for a specific message you can use the `X-Sending-Zone` header key

```
X-Sending-Zone: zone-identifier
```

For example if you have a Sending Zone called "zone-identifier" set then messages with such header are routed through this Sending Zone.

> **NB** This behavior is enabled by default only for 'api' and 'bounce' zones, see the `allowRoutingHeaders` option in default config for details

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

Use `senderDomains` option in the Zone config to define that all senders with a specific From domain name are routed through this Zone.

```javascript
'sending-zone': {
    ...
    senderDomains: ['example.com']
}
```

#### Routing based on recipient domain name

Use `recipientDomains` option in the Zone config to define that all recipients with a specific domain name are routed through this Zone.

```javascript
'sending-zone': {
    ...
    recipientDomains: ['gmail.com', 'kreata.ee']
}
```

#### Default routing

The routing priority is the following:

1.  By the `X-Sending-Zone` header
2.  By matching `routingHeaders` headers
3.  By sender domain value in `senderDomains`
4.  By recipient domain value in `recipientDomains`

If no routing can be detected, then the "default" zone is used.

### IPv6 support

IPv6 is supported but not enabled by default. You can enable or disable it per Sending Zone with the `ignoreIPv6` option.

### Per-Zone domain connection limits

You can set connection limits for recipient domains per Sending Zone. For example if you have set max 2 connections to a specific domain then even if your queue processor has free slots and there are a lot of messages queued for that domain it will not create more connections than allowed.

### Bounce handling

ZoneMTA tries to guess the reason behind rejecting a message – maybe the message was greylisted or maybe your sending IP is blocked by this recipient. Not every bounce is equal.

If the message hard bounces (or after too many retries for soft bounces) a bounce notification is POSTed to an URL. You can also define that a bounce response is sent to the sender email address. See more [here](https://github.com/zone-eu/zone-mta/wiki/Receiving-bounce-notifications)

### Blacklist back-off

If the bounce occured because your sending IP is blacklisted then this IP gets disabled for that MX for the next 6 hours and message is retried from a different IP. You can also disable local IP addresses permanently for specific domains with `disabledAddresses` option.

### Error Recovery

ZoneMTA is an _at-least-once delivery_ system, so messages are deleted from the queue only after positive response from the receiving MX server. If a child starts processing a message the child locks the message and the lock is released automatically if the child dies or master dies. Once normal operations are resumed, the same message can be fetched from the queue again.

Child processes that handle actual delivery keep a TCP connection up against the master process. This connection is used as the data channel for exchanging information about deliveries. If the connection drops for any reason, all current operations are cancelled by the child and non-delivered messages are re-queued by the master. This behavior should limit the possibility of multiple deliveries of the same message. Multiple deliveries can still happen if the process or connection dies exactly on the moment when the MX server acknowledges the message and the notification does not get propagated to the master. This risk of multiple deliveries is preferred over losing messages completely.

Messages might get lost if the database gets into a corrupted state and it is not possible to recover data from it.

### IP Warm-Up

You can assign a new IP to the IP pool using lower load share than other addresses by using `ratio` option (value in the range of 0 and 1 where 0 means that this IP is never used and 1 means that only this IP is used)

```javascript
{
    pools: {
        default: [
            {name: 'host1.example.com', address: '1.2.3.1'},
            {name: 'host2.example.com', address: '1.2.3.2'},
            {name: 'host3.example.com', address: '1.2.3.3'},
            // the next address gets only 5% of the messages to handle
            {name: 'warmup.example.com', address: '1.2.3.4', ratio: 1/20}
        ]
    }
}
```

Once your IP address is warm enough then you can either increase the load ratio for it or remove the parameter entirely to share load evenly between all addresses. Be aware though that every time you change pool structure it mixes up the address resolving, so a message that is currently deferred for greylisting does not get the same IP address that it previously used and thus might get greylisted again.

### Delivery to HTTP

Instead of delivering messages to SMTP you can POST messages to HTTP. In this case you need to set http option for a delivery to true and also set targetUrl property which is the URL the message is POSTed to as a file upload. These changes can be done for example in a plugin.

```javascript
app.addHook('sender:fetch', (delivery, next) => {
    delivery.http = true;
    delivery.targetUrl = 'http://requestb.in/1ed6q7l1';
    next();
});
```

### Multiple instances support

You can start up multiple ZoneMTA servers that share the same MongoDB backend. In this case you have to edit the queue/instanceId configuration option though, every instance needs its own immutable ID. This value is used to lock deferred messages to specific sender instance.

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

In the same manner you could upload raw rfc822 message for delivery. In this case the sender and recipient info would be fetched from the message.

```bash
curl -H "Content-Type: message/rfc822" -H "X-Authenticated-User: andris" -H "X-Originating-IP: 123.123.123.123" -X POST  http://localhost:8080/send-raw -d 'From: sender@example.com
To: recipient1@example.com, recipient2@example.com
Subject: Hello!

Hello world'
```

#### Zone status

You can check the current state of a sending zone (for example "default") with the following query

```bash
curl http://localhost:8080/counter/zone/default
```

The response includes counters about queued and deferred messages

```json
{
    "active": {
        "rows": 13
    },
    "deferred": {
        "rows": 17
    }
}
```

You can check counters for all zones with:

```bash
curl http://localhost:8080/counter/zone/
```

#### Queued messages

You can list the first 1000 messages queued or deferred for a queue

```bash
curl http://localhost:8080/queued/active/default
```

Replace _active_ with _deferred_ to get the list of deferred messages.

The response includes an array of messages

```json
{
    "list": [
        {
            "id": "157ca04cd5c000ddea",
            "zone": "default",
            "recipient": "example@example.com"
        }
    ]
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
        "headers": [
            {
                "key": "date",
                "line": "Date: Mon, 03 Oct 2016 12:26:32 +0000"
            },
            {
                "key": "from",
                "line": "From: Sender <sender@example.com>"
            },
            {
                "key": "message-id",
                "line": "Message-ID: <95dc84ae-ff9e-4e95-aa75-8ee707bc018d@example.com>"
            },
            {
                "key": "subject",
                "line": "subject: test"
            }
        ],
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
    "messages": [
        {
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
        }
    ]
}
```

#### Message body

If you know the queue id (for example 1578a823de00009fbb) then you can fetch the entire message contents

```bash
curl http://localhost:8080/fetch/1578a823de00009fbb
```

The response is a _message/rfc822_ message. It does not include a Received header for ZoneMTA or a DKIM signature header, these are added when sending out the message.

```
Content-Type: text/plain
From: sender@example.com
To: exmaple@example.com
Subject: testmessage
Message-ID: <4f7e73c3-009c-48c2-4b45-1cf20b2fe6d3@example.com>
Date: Sat, 15 Oct 2016 20:24:54 +0000
MIME-Version: 1.0

Hello world! This is a test message
...
```

#### Suppression list

ZoneMTA allows basic recipient suppression where messages to specific recipient addresses or domains are silently dropped. Suppressed messages do not generate bounce messages.

To see the currently suppressed addresses/domains, make a HTTP call to _/suppressionlist_

```bash
curl http://localhost:8080/suppressionlist
```

The result is an JSON array

```json
{
    "suppressed": [
        {
            "id": "58da63cc77ebe70b883bec2d",
            "address": "suppressed@address.com"
        },
        {
            "id": "58da641f77ebe70b883bec2e",
            "domain": "suppressed-domain.com"
        }
    ]
}
```

#### Add address or domain to Suppression list

You can add suppression entries by address or domain

**Suppress an email address**

```bash
curl -XPOST http://localhost:8080/suppressionlist -H 'Content-Type: application/json' -d '{
  "address": "suppressed@address.com"
}'
```

With the result

```json
{
    "suppressed": {
        "id": "58da63cc77ebe70b883bec2d",
        "address": "suppressed@address.com"
    }
}
```

**Suppress a domain**

```bash
curl -XPOST http://localhost:8080/suppressionlist -H 'Content-Type: application/json' -d '{
  "domain": "suppressed-domain.com"
}'
```

With the result

```json
{
    "suppressed": {
        "id": "58da641f77ebe70b883bec2e",
        "domain": "suppressed-domain.com"
    }
}
```

#### Delete an entry from Suppression list

You can delete suppression entries by entry ID

```bash
curl -XDELETE http://localhost:8080/suppressionlist -H 'Content-Type: application/json' -d '{
  "id": "58da641f77ebe70b883bec2e"
}'
```

With the result

```json
{
    "deleted": "58da641f77ebe70b883bec2e"
}
```

#### Metrics for Prometheus

ZoneMTA automatically collects and exposes metrics for [Prometheus](https://prometheus.io/)

```bash
curl http://localhost:8080/metrics
```

In your Prometheus config, the server should be linked like this:

```
  static_configs:
    - targets: ['localhost:8080']
```

![](https://cldup.com/GaUfMKE9zE.png)

The exposed metrics include a lot of different data but the most important ones would be the following:

##### zonemta_delivery_status

`zonemta_delivery_status` exposes counters for delivery statuses. There are 3 different `result` label values

*   `result="delivered"` – count of deliveries accepted by remote MX
*   `result="rejected"` – count of deliveries that hard bounced
*   `result="deferred"`– count of deliveries that soft bounced

##### zonemta_message_push

`zonemta_message_push` exposes a counter about stored emails. This counter includes the count of messages accepted for delivery.

##### zonemta_message_drop

`zonemta_message_drop` exposes a counter about emails that were not accepted for delivery (rejected as spam, rejected by plugins, failed to store messages to db etc.)

##### zonemta_queue_size

`zonemta_queue_size` exposes gauges about current size of the queue. There are 2 `type` labels available:

*   `type="queued"` – count of deliveries waiting to be delivered on the first occasion
*   `type="deferred"` – count of deliveries waiting to be delivered on some later time

##### zonemta_blacklisted

`zonemta_blacklisted` exposes a gauge about currently blacklisted domain:localAddress combos. This value is reset to 0 whenever ZoneMTA master process is restarted. Additionally the blacklist information is cached for 6 hours.

### Utilities

`check-bounces`

Cli command that reads a SMTP error response from stdin and returns bounce information

```bash
$ echo "552-5.7.0 This message was blocked because its content presents a potential
552-5.7.0 security issue. Please visit
552-5.7.0 http://support.google.com/mail/bin/answer.py?answer=6590 to review our
552 5.7.0 message content and attachment content guidelines. cp3si16622595oec.101 - gsmtp" | check-bounce

> data     : 552-5.7.0 This message was blocked because its content presents a potential
>            552-5.7.0 security issue. Please visit
>            552-5.7.0 http://support.google.com/mail/bin/answer.py?answer=6590 to review our
>            552 5.7.0 message content and attachment content guidelines. cp3si16622595oec.101 - gsmtp
> action   : reject
> message  : Suspicious attachment
> category : virus
> code     : 552
> status   : 5.7.0
```

## TODO

### 1\. Domain based throttling

Currently it is possible to limit active connections against a domain and you can limit sending speed per connection (eg. 10 messages/min per connection) but you can't limit sending speed per domain. If you have set 3 processes, 5 connections and limit sending with 10 messages / minute then what you actually get is `3 * 5 * 10 = 150` messages per minute for a Sending Zone.

## Notes

### Memory usage

In production you probably would want to allow Node.js to use more memory, so you should probably start the app with `--max-old-space-size` option

```
node --max-old-space-size=8192 app.js
```

This is mostly needed if you want to allow large SMTP envelopes on submission (eg. someone wants to send mail to 10 000 recipients at once) as all recipient data is gathered in memory and copied around before storing to the queue.

### DNS

For speedier DNS resolving there are two options. First (the default) is to cache DNS responses by ZoneMTA in Redis using the [dnscache](https://www.npmjs.com/package/dnscache) module. For better performance it would probably be better to use a dedicated DNS server, mostly because DNS caching is hard and it is better to leave it to software that is built for this.

[dnsmasq](http://www.thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html) on localhost has worked great for us. The dns options for ZoneMTA would look like this if you are using local DNS cache like dnsmasq or similar:

```
"dns": {
    "caching": false,
    "nameservers": ["127.0.0.1"]
}
```

## License

European Union Public License 1.2 ([details](http://ec.europa.eu/idabc/eupl.html)) or later

ZoneMTA is created and maintained in the European Union, licensed under EUPL and its authors have no relations to the US, thus there can not be any infringements of US-based patents.
