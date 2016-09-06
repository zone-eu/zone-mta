# ZoneMTA (internal code name X-699)

Modern outbound SMTP relay (MTA/MSA) built on Node.js and LevelDB.

> This is a **labs project** meaning that ZoneMTA is **not tested in production**. In the future it should replace our outbound Postfix servers but so far no actual mail servers have been deployed with ZoneMTA. Handle with care!

```
 _____             _____ _____ _____
|__   |___ ___ ___|     |_   _|  _  |
|   __| . |   | -_| | | | | | |     |
|_____|___|_|_|___|_|_|_| |_| |__|__|
```

The goal of this project is to provide granular control over routing different messages. Trusted senders can be routed through high-speed (more connections) virtual "sending zones" that use high reputation IP addresses, less trusted senders can be routed through slower (less connections) virtual "sending zones" or through IP addresses with less reputation. In addition the server comes packed with features more common to commercial software, ie. HTML rewriting or HTTP API for posting messages.

## Features

- Fast. Send millions of messages per day
- Send large messages with low overhead
- Automatic DKIM signing
- Rewrite HTML content, add tracking links etc.
- Adds Message-Id and Date headers if missing
- Queue is stored in LevelDB
- Sending Zone support: send different messages using different IP addresses
- Assign specific recipient domains to specific Sending Zones
- Built in IPv6 support
- Uses STARTTLS for outgoing messages by default, so no broken padlock images in Gmail
- Smarter bounce handling
- Throttling per Sending Zone connection
- Built-in support for delayed messages. Use a future value in the Date header and the message is not sent out before that time
- Spam detection using Rspamd
- HTTP API to send messages

Check the [WIKI](https://github.com/zone-eu/zone-mta/wiki) for more details

## Setup

1. Requirements: Node.js v6+ for running the app + compiler for building LevelDB bindings
2. Open ZoneMTA folder and install required dependencies: `npm install --production`
3. Modify configuration script (if you want to allow connections outside localhost make sure the feeder host is not bound to 127.0.0.1)
4. Run the server application: `node app.js`
5. If everything worked then you should have a relay SMTP server running at localhost:2525 (user "test", password "zone", no TLS)
6. You can find the stats about queues at `http://hostname:8080/queue/default` where `default` is the default Sending Zone name. For other zones, replace the identifier in the URL. The queue counters are approximate.
7. If you want to scan outgoing messages for spam then you need to have a [Rspamd](https://rspamd.com/) server running

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
6. Send a message to application host port 2525, using username 'test' and password 'zone'

## Features

### HTTP usage

All communication between ZoneMTA and your actual configuration server is handled over HTTP. For example when a user needs to be authenticated then ZoneMTA makes a HTTP request with user info to a provided HTTP address. If ZoneMTA wants to notify about a bounced message then a HTTP request is made. If ZoneMTA wants to check if an user can send messages another HTTP request is made etc. It also means that ZoneMTA does not have a built in user database, this is left entirely to your own application.

### Large message support

All data is processed in chunks without reading the entire message into memory, so it does not matter if the message is 1kB or 1GB in size.

### LevelDB backend

Using LeveldDB means that you do not run out of inodes when you have a large queue, you can pile up even millions of messages (assuming you do not run out of disk space first)

### DKIM signing

DKIM signing support is built in to ZoneMTA. If a new mail transaction is initiated a HTTP call is made against configuration server with the transaction info (includes MAIL FROM address, authenticated username and connection info). If the configuration server responds with DKIM keys (multiple keys allowed) then these keys are used to sign the outgoing message.

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

If authentication is required then all clients are authenticated against a HTTP endpoint using Basic access authentication. If the HTTP request succeeds then the user is considered as authenticated.

### Per-Zone domain connection limits

You can set connection limits for recipient domains per Sending Zone. For example if you have set max 2 connections to a specific domain then even if your queue processor has free slots and there are a lot of messages queued for that domain it will not create more connections than allowed.

### Bounce handling

ZoneMTA tries to guess the reason behind rejecting a message – maybe the message was greylisted or maybe your sending IP is blocked by this recipient. Not every bounce is equal.

If the message hard bounces (or after too many retries for soft bounces) a bounce notification is POSTed to an URL. You can also define that a bounce response is sent to the sender email address.

### Error Recovery

ZoneMTA is an _at-least-one delivery_ system. Child processes that handle actual delivery keep a TCP connection up against the master process. This connection is used as the data channel for exchanging information about deliveries. If the connection drops for any reason, all current operations are cancelled by the child and non-delivered messages are re-queued by the master. This behavior should limit the possibility of multiple deliveries of the same message. Multiple deliveries can still happen if the process or connection dies exactly on the moment when the MX server acknowledges the message. This risk of multiple deliveries is preferred over losing messages completely.

### HTTP API

You can post a JSON structure to a HTTP endpoint (if enabled) and it will be converted into a rfc822 formatted message and delivered to destination. The JSON structure follows Nodemailer email config (see [here](https://github.com/nodemailer/nodemailer#e-mail-message-fields)) except that file and url access is disabled – you can't define an attachment that loads its contents from a file path or from an url, you need to provide the file contents as base64 encoded string.

```
curl -H "Content-Type: application/json" -X POST  http://localhost:8080/send -d '{
    "from": "andris@nodemailer.com",
    "to": "andris.reinman@gmail.com",
    "subject": "hello",
    "text": "Hello world!",
    "html": "<p>Hello world!</p>"
}'
```

Or if authentication is required, provide the basic authorization headers as well

```
curl -H "Content-Type: application/json" -X POST  http://zone:test@localhost:8080/send -d '{
    "from": "andris@kreata.ee",
    "to": "andris.reinman@gmail.com, andmekala@hot.ee",
    "subject": "hello",
    "text": "hello world!"
}'
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

## License

European Union Public License 1.1 ([details](http://ec.europa.eu/idabc/eupl.html))

In general, EUPLv1.1 is compatible with GPLv2, so it's a _copyleft_ license. Unlike GPL the EUPL license has legally binding translations in every official language of the European Union, including the Estonian language. This is why it was preferred over GPL.
