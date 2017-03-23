# ZoneMTA plugins

If you create a ZoneMTA app using the command line tool then you should have a folder called "plugins" in the application directory. This is where you can put your custom plugins that can be included in the main process. To enable a plugin edit "plugins" section in application configuration and add the plugin information into it. Plugin locations are resolved relative to the application plugins folder, so using "./my-plugin" would point to "path/to/app/plugins/my-plugin". Exception is core plugins (starts with "core/") which resolve to the core plugins folder in ZoneMTA source and plugins installed from npm (start with "module/").

## Installable plugins

Here's some plugins that you can install from npm:

- [zonemta-delivery-counters](https://github.com/andris9/zonemta-delivery-counters) – needed by [ZMTA-WebAdmin](https://github.com/zone-eu/zmta-webadmin), counts sent and bounced messages
- [zonemta-loop-breaker](https://github.com/andris9/zonemta-loop-breaker) – helps to detect and break mail loops, ensures that the same message is not sent to the same recipient more than once by adding a tracking header

## Create plugins

Plugin files should expose a property called `title` to identify themselves. If title is not provided, then file name is used instead.

Plugins must expose an `init` method. This method should be used to register the plugin to all required hooks

```javascript
module.exports.title = 'My Awesome Plugin';
module.exports.init = function(app, done){
    // handle plugin initialization
    app.addHook(...);
    done();
};
```

Plugins are loaded in the order defined in `config.plugins` object. Plugins are loaded to the context of the main process but only after the current user is downgraded from root.

## Configuration

Whatever you pass to the plugin key in config.plugins section is provided as `app.config`. You can pass `true` as the configuration if you do not need to set anything besides the default but want to enable it.

Config file:

```json
{
    "plugins": {
        "my-plugin": {
            "enabled": true,
            "my-value": 123
        }
    }
}
```

Plugin file "./plugins/user/my-plugin.js":

```javascript
module.exports.init = function(app, done){
    console.log(app.config['my-value']); // 123
    done();
}
```

The property `enabled` indicates if the plugin must be loaded or not. The value indicates the context where this plugins should be loaded, if you pass `true` then the plugin is loaded in _'receiver'_ context (eg. when accepting messages to the queue). To use also delivery hooks you should set the value as _'sender'_ or if you want to use hooks in both contexts, use an array of context strings. _'main'_ runs in the master process.

```json
{
    "plugins": {
        "user/my-plugin": {
            "enabled": ["main", "receiver", "sender"]
        }
    }
}
```

## Available hooks

Hooks can be set up with the following command

```javascript
app.addHook(name, handler);
```

Where

- **name** is the event to hook into
- **handler** is the hook function. Actual arguments vary by the hook but the last argument is always a return function that needs to be called before the message can be further processed

Possible hook names are the following:

**'main' context**

To use these hooks you need to set `enabled` `'main'` or `['main',...]`

- **'api:mail'** with arguments `envelope`, `session`, called when an email is dropped to HTTP
- **'queue:bounce'** with arguments `bounce` called when a message bounced and is no longer queued for delivery
- **'queue:release'** with arguments `zone`, `data` called when a message was removed from the queue
- **'queue:route'** with arguments `envelope`, `routing` called before a message entry is stored to message index. This is your last chance to edit message routing for a single recipient. Message for this specific recipient is routed to `routing.deliveryZone`. If this zone does not exist, then your message is never sent and sits in the queue forever.

**'receiver' context**

To use these hooks you need to set `enabled` to `true` or `'receiver'` or `['receiver',...]`

- **'smtp:auth'** with arguments `auth`, `session`, called when AUTH command is issued by the client
- **'smtp:mail_from'** with arguments `address`, `session`, called when MAIL FROM command is issued by the client
- **'smtp:rcpt_to'** with arguments `address`, `session`, called when RCPT TO command is issued by the client
- **'smtp:data'** with arguments `envelope`, `session`, called when DATA command is issued by the client
- **'message:headers'** with arguments `envelope`, `messageInfo` called when rfc822 headers are found from the incoming message (see `envelope.headers` property for the headers)
- **'message:store'** with arguments `envelope`, `body` _(stream)_ called when message is about to be stored to disk. You should not modify the `body` stream in any way, otherwise you break the body hash, this hook is provided in case you want to store a message somewhere else than the outbound queue
- **'message:queue'** with arguments `envelope`, `messageInfo` called when message is processed and ready to be pushed to queue. You should not modify the `body` stream in any way, otherwise you break the body hash

**'sender' context**

To use these hooks you need to set `enabled` to `'sender'` or `['sender',...]`

- **'sender:fetch'** with arguments `delivery` called when message is retrieved from queue for delivery
- **'sender:headers'** with arguments `delivery`, `connection` called when message is about to be sent (but before DKIM signing), this is your final chance to modify message headers or SMTP envelope. Do not spend too much time here as the SMTP connection is already open and might timeout. use _'sender:connect'_ hook to perform actions that take more time
- **'sender:connect'** with arguments `delivery`, `options` called before connection is tried to open against the MX. If the options object includes a property socket after hook is finished, then this socket object is used to start the SMTP session

### Errors

If you return an error with the smtp hook callback then the error message is returned to the client as the SMTP response. To set a specific return code to be returned, use `responseCode` property. Hook is processed until first error occurs.

```javascript
app.addHook('smtp:auth', (auth, session, next) => {
    let err = new Error('Invalid password');
    err.responseCode = 535;
    next(err);
});
```

### _session_ object

`session` object is provided by smtp hooks. This is a state object provided by _smtp-server_ module, see details [here](https://github.com/andris9/smtp-server#session-object).

Session object has the additional properties:

- **interface** includes the key of the source interface (eg 'feeder' or 'mx')

> **NB** Actual contents of the session object might differ from what is listed here. Nothing is probably removed but there might be some additional properties added that are not yet documented. You can check out actual properties when developing your plugin by simply calling `console.log(session)`

### _auth_ object

`auth` object is provided by the 'smtp:auth' hook and it includes credentials used for authentication.

- **username** includes the username provided by the client
- **password** includes the password provided by the client
- **method** provides the SMTP command used for authentication (eg. `'PLAIN'` or `'LOGIN'`)

### _address_ object

Address objects are provided by the envelope hooks (_smtp:mail_from_ and _smtp:rcpt_to_). This is not just an address but also any extension data provided by the client. The object includes the following properties:

- **address** is the email address as a string
- **args** is an object with additional extension arguments (all key names are uppercase)

```javascript
let address = {
    address: 'sender@example.com',
    args: {
      SIZE: '12345',
      RET: 'HDRS'
    }
};
```

In most cases you probably only care about the `address.address` email address and not about the extension data from `address.args`.

### _envelope_ object

`envelope` object includes all properties that get stored about the message to the queue. If you want to store your own data as well, you can edit the object, just do not put anything in it that can not be converted to JSON (circular references, host objects like Buffers etc).

The object builds up in different steps, you can see the final envelope data in _message:store_ hook, until then some of the data is missing or might change.

- **id** is the queue ID for this message
- **interface** includes the key of the source interface (eg 'feeder' or 'api')
- **from** email address from MAIL FROM
- **to** an array of email address strings from RCPT TO
- **origin** remote IP address of the connecting client
- **originhost** reverse resolved hostname of the client IP
- **transhost** hostname provided by EHLO or HELO command
- **transtype** transmission protocol (SMTP, ESTMP, ESTMPS, LMTP, HTTP etc.)
- **user** username of the authenticated user (if authentication is used)
- **time** date object of the envelope creation time
- **tls** cipher string if client is using secure connection
- **deferDelivery** timestamp in milliseconds for the minimal delivery time. The message is not sent out before this deadline. If not set or the timestamp is the past then the message is sent out as soon as possible
- **date** includes the value of the Date: header
- **parsedEnvelope** includes envelope values from mail header
    - **from** the first address from the From: header (email address string without name part)
    - **to** the addresses as an array from the To: header (email address strings without name part)
    - **cc** the addresses as an array from the Cc: header (email address strings without name part)
    - **bcc** the addresses as an array from the Bcc: header (email address strings without name part)
    - **replyTo** the first address from the Reply-To: header (email address string without name part)
    - **sender** the first address from the Sender: header (email address string without name part)
- **messageId** the Message-Id header value (eg. `<unique@domain>`)
- **sendingZone** the name of the sending zone to use (eg `'default'` or `'bounces'`)

> **NB** Actual contents of the envelope object might differ from what is listed here. Nothing is probably removed but there might be some additional properties added that are not yet documented. You can check out actual properties when developing your plugin by simply calling `console.log(envelope)`

If you add your own properties to the envelope object or modify existing ones then these are persisted and available in other hooks and later also from the delivery object. Only use values that can be serialized into JSON for custom properties.

```javascript
app.addHook('smtp:data', (envelope, session, next) => {
    // Override existing source IP with something else.
    // This value ends up in the Received header
    envelope.origin = '1.2.3.4';
    // Add new custom property
    envelope.my_custom_value = 123;
    next();
});

app.addHook('sender:fetch', (delivery, next) => {
    console.log(envelope.my_custom_value); // 123;
    next();
});
```

### _headers_ object

`headers` allow you to list and manipulate headers of the message or a specific message node.

- **headers.get(key)** returns an array of strings with all header rows for the selected key (these are full header lines, so key name is part of the row string, eg. `["Subject: This is subject line"]`)
- **headers.getFirst(key)** returns string value of the specified header key (eg `"This is subject line"`)
- **headers.add(key, value [,index])** adds a new header value to the specified index or to the top of the header block if index is not specified
- **headers.update(key, value)** replaces a header value for the specified key
- **headers.delete(key)** remove header value for the specified key

## Using Message Analyzer

If you want to check the original data stream coming from the input you can process it with the analyzer hook. You can modify the data inside the hook but this affects the next analyzers as these get their input from the output of your hook

```javascript
app.addAnalyzerHook(handler);
```

Where

- **handler** is a function that processes the message stream. The function gets the following arguments:

  - **envelope** is an object with the sender and recipient info
  - **source** is a readable stream for that contains the data sent by client
  - **destination** is a writable stream where you must write the message stream. This becomes the input for the following stream handlers

If you want to reject the message based on something detected from the message then you have 2 options

- emit an error in the stream (not recommended)
- store the information somewhere and set up a hook for _'message:store'_ where you can check the stored information and reject the message

```javascript
module.exports.title = 'My Awesome Plugin';
module.exports.init = function(app, done){
    let state = new WeakMap();
    app.addAnalyzerHook((envelope, source, destination)=>{
        // store a random boolean to the WeakMap structure using envelope value as the key
        state.set(envelope, Math.random() >= 0.5);
        source.pipe(destination);
    });
    app.addHook('message:store', (envelope, body, next)=>{
        // check from the WeakMap structure if there's a `true` for the envelope
        if(!state.get(envelope)){
            // do not accept the message for delivery
            return next(new Error('You have been randomly denied'));
        }
        next(); // everything OK
    });
    done();
};
```

## Using Message Rewriter

You can modify individual message nodes by setting up a message rewriter hook that targets mime tree nodes that match a specific criteria. The input and output streams of the node are already processed so you do not have to decode or encode anything yourself. Additionally you can modify the headers of the node.

```javascript
app.addRewriteHook(filter, handler);
```

Where

- **filter** is a function that is called for every found mime node. If the function returns true, than this node will be processed, otherwise it is skipped. The function gets two arguments: `envelope` and `node`
- **handler** is a function that processes the node. The function gets the following arguments:

  - **envelope** is an object with the sender and recipient info
  - **node** is an object that references the current mime tree leaf, it includes the headers but not the body
  - **source** is a readable stream for reading attachment content as a byte stream
  - **destination** is a writable stream for generating new contents for the attachment

See [here](https://github.com/andris9/mailsplit#manipulating-headers) for the full list of methods and options available the `node` object.

**NB** once you have written something to the `encoder` stream, you can't modify node headers anymore. If you modify headers after writing data to the `message` stream you might run into race conditions where you can not know if the updated header data was actually used or not.

## Using Message Streamer

You can stream individual message nodes by setting up a message streamer hook that targets mime tree nodes that match a specific criteria. The input streams of the node is already processed so you do not have to decode anything yourself.

```javascript
app.addStreamHook(filter, handler);
```

Where

- **filter** is a function that is called for every found mime node. If the function returns true, than this node will be processed, otherwise it is skipped. The function gets two arguments: `envelope` and `node`
- **handler** is a function that processes the node. The function gets the following arguments:

  - **envelope** is an object with the sender and recipient info
  - **node** is an object that references the current mime tree leaf, it includes the headers but not the body
  - **source** is a readable stream for reading attachment content as a byte stream
  - **done** is a function to call once the stream is processed

See [here](https://github.com/andris9/mailsplit#manipulating-headers) for the full list of methods and options available the `node` object.

**NB** you can't modify headers of the node as these are already passed on

See example plugin [here](core/example-plugin.js)

## Checking and Rewriting addresses

The `app` object exposes a method `validateAddress` method to check and if needed, to overwrite an address header

```javascript
app.validateAddress(headers, key)
```

Where

- **header** is an Headers object, eg. _delivery.headers_ or _envelope.headers_
- **key** is a key to check for, eg. _from_ or _to_ or _cc_

Return value is an object with the following properties:

- **addresses** an array of e-mail addresses found for that key (structured values)
- **set** _(addresses)_ a method that overrides original key with new addresses

**Example**

```javascript
// From: Sender Name <sender@example.com>
let from = app.validateAddress(envelope.headers, 'from');
from.addresses // [{name:'Sender Name', address: 'sender@example.com'}]
from.set('My Name <first@blurdybloop.com>');
// From: first@blurdybloop.com
from.set({
    name: 'My Name',
    address: 'first@blurdybloop.com'
});
// From: first@blurdybloop.com
```
