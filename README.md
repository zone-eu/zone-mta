# ZoneMTA (project X-699)

Tiny outbound SMTP relay (MTA/MSA) built on Node.js and LevelDB.

The goal of this project is to provide granular control over routing different messages. Trusted senders can be routed through high-speed "sending zones" that use high reputation IP addresses, less trusted senders can be routed through slower "sending zones" or through IP addresses with less reputation.

## Features

- Fast. Send hundreds of thousands messages per hour
- Send large messages with low overhead
- Automatic DKIM signing
- Adds Message-Id and Date headers if missing
- Queue is stored in LevelDB
- Sending Zone support: send different messages using different IP addresses
- Assign specific recipient domains to specific Sending Zones
- Built in IPv6 support
- Uses STARTTLS for outgoing messages by default, so no broken padlock images in Gmail
- Smarter bounce handling
- Throttling per Sending Zone connection
- Built-in support for delayed messages. Just use a future value in the Date header and the message is not sent out before that time

## Setup

1. Requirements: Node.js v6+ for running the app + compiler for building leveldb and snappy bindings

2. Open ZoneMTA folder and install required dependencies: `npm install`

3. Modify configuration script (if you want to allow connections outside localhost make sure the feeder host is not bound to 127.0.0.1)

4. Run the server application: `node app.js`

5. If everything worked then you should have a relay SMTP server running at localhost:2525 (user "test", password "zone", no TLS)

6. You can find the stats about queues at `http://hostname:8080/queue/default` where `default` is the default Sending Zone name. For other zones, replace the identifier in the URL. The queue counters are approximate.

You can run the server using any user account. If you want to bind to a low port (eg. 587) you need to start out as _root_. Once the port is bound the user is downgraded to some other user defined in the config file (root privileges are not required once the server has started). The user the server process runs as must have write permissions for the leveldb queue folder.

## Install as a service

1. Move zone-mta folder to /opt/zone-mta
2. Copy Systemd service file: `cp ./setup/zone-mta.service /etc/systemd/system/`
3. Enable Systemd service: `systemctl enable zone-mta.service`
4. Start the service: `service zone-mta start`
5. Send a message to application host port 2525, using username 'test' and password 'zone'

## Large message support

All data is processed in chunks without reading the entire message into memory, so it does not matter if the message is 1kB or 1GB in size.

## LevelDB backend

Using LeveldDB means that you do not run out of inodes when you have a large queue, you can pile up even millions of messages (assuming you do not run out of disk space first)

## DKIM signing

DKIM signing support is built in to ZoneMTA. All you need to do is to provide signing keys to use it. DKIM private keys are stored in _./keys_ as _{DOMAIN}.{SELECTOR}.pem_.

For example if you want to use a key for "kreata.ee" with selector "test" then this private key should be available at ./keys/kreata.ee.test.pem

DKIM signature is based on the domain name of the From: address or if there is no From: address then by the domain name of the envelope MAIL FROM:. If a matching key can not be found then the message is not signed.

## Sending Zone

You can define as many Sending Zones as you want. Every Sending Zone can have its own local address IP pool that is used to send out messages designated for that Zone. You can also specify the amount of max parallel outgoing connections for a Sending Zone.

### Routing by Zone name

To preselect a Zone to be used for a specific message you can use the `X-Sending-Zone` header key

```
X-Sending-Zone: zone-identifier
```

For example if you have a Sending Zone called "zone-identifier" set then messages with such header are routed through this Sending Zone.

### Routing based on specific header value

You can define specific header values in the Sending Zone configuration with the `routingHeaders` option. For example if you want to send messages that contain the header 'X-User-ID' with value '123' then you can configure it like this:

```javascript
{
    name: 'sending-zone',
    ...
    routingHeaders: {
        'x-user-id': '123'
    }
}
```

### Routing based on sender domain name

You also define that all senders with a specific From domain name are routed through a specific domain. Use `senderDomains` option in the Zone config.

```javascript
{
    name: 'sending-zone',
    ...
    senderDomains: ['example.com']
}
```

### Routing based on recipient domain name

You also define that all recipients with a specific domain name are routed through a specific domain. Use `recipientDomains` option in the Zone config.

```javascript
{
    name: 'sending-zone',
    ...
    recipientDomains: ['gmail.com', 'kreata.ee']
}
```

### Default routing

The routing priority is the following:

1. By the `X-Sending-Zone` header
2. By matching `routingHeaders` headers
3. By sender domain value in `senderDomains`
4. By recipient domain value in `recipientDomains`

If no routing can be detected, then the "default" zone is used.

## IPv6 support

IPv6 is supported by default. You can disable it per Sending Zone if you don't need to or can't send messages over IPv6.

## HTTP based authentication

If authentication is required then all clients are authenticated against a HTTP endpoint using Basic access authentication. If the HTTP request succeeds then the user is considered as authenticated.

## Per-Zone domain connection limits

You can set connection limits for recipient domains per Sending Zone. For example if you have set max 2 connections to a specific domain then even if your queue processor has free slots and there are a lot of messages queued for that domain it will not create more connections than allowed.

## Bounce handling

ZoneMTA tries to guess the reason behind rejecting a message – maybe the message was greylisted or maybe your sending IP is blocked by this recipient. Not every bounce is equal.

If the message hard bounces (or after too many retries for soft bounces) a bounce notification is POSTed to an URL.

## Error Recovery

Child processes keep file based logs of delivered messages. Whenever a child process crashes or master process goes down this log is used to identify messages that are successfully delivered but are still in the queue. This behavior should limit the possibility of multiple deliveries of the same message. Multiple deliveries can still happen if the process dies exactly on the moment when the MX server acknowledges the message and the process is starting to write to the log file. This risk of preferred multiple deliveries is preferred over losing messages completely.

## TODO

### 1\. Better handling of DKIM keys

Currently all DKIM keys are loaded into memory on startup by all processes which is not cool, especially if you have a large number of keys

### 2\. Domain based throttling

Currently it is possible to limit active connections against a domain and you can limit sending speed per connection (eg. 10 messages/min per connection) but you can't limit sending speed per domain. If you have set 3 processes, 5 connections and limit sending with 10 messages / minute then what you actually get is 3 _5_ 10 = 150 messages per minute for a Sending Zone.

### 3\. Web interface

It should be possible to administer queues using an easy to use web interface.

### 4\. Replace LevelDB with RocksDB

RocksDB has much better performance both for reading and writing but it's more difficult to set up

## Notes

In production you probably would want to allow Node.js to use more memory, so you should probably start the app with `–max-old-space-size` option

```
node –max-old-space-size=8192 app.js
```

This is mostly needed if you want to allow large SMTP envelopes on submission (eg. someone wants to send mail to 10 000 recipients at once) as all recipient data is gathered in memory and copied around before storing to the queue.
