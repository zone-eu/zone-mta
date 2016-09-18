# ZoneMTA plugins

This is the folder for plugins. Files that reside here can be included in the main process. To enable a plugin edit [application configuration](../config/default.js) section "plugins" and add the plugin information into it.

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

Plugins are loaded in the order defined in `config.plugins` object. Plugins are loaded to the context of the main process but only after the running user is downgraded from root.

## Configuration

Whatever you pass to the plugin key in config.plugins section is provided as `app.config`

Config file:

```json
{
    "plugins": {
        "./my-plugin": {
            "enabled": true,
            "my-value": 123
        }
    }
}
```

Plugin file "my-plugin.js":

```javascript
module.exports.init = function(app, done){
    console.log(app.config['my-value']); // 123
    done();
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

- **'feeder:auth'** with arguments `auth`, `session`, called when AUTH command is issued by the client
- **'feeder:mail_from'** with arguments `address`, `session`, called when MAIL FROM command is issued by the client
- **'feeder:rcpt_to'** with arguments `address`, `session`, called when RCPT TO command is issued by the client
- **'feeder:data'** with arguments `envelope`, `session`, called when DATA command is issued by the client
- **'message:headers'** with arguments `envelope`, `headers`, called when rfc822 headers are found from the incoming message
- **'message:store'** with arguments `envelope`, `headers` called when message is processed and ready to be pushed to queue

### Errors

If you return an error with the feeder hook callback then the error message is returned to the client as the SMTP response. To set a specific return code to be returned, use `responseCode` property. Hook is processed until first error occurs.

```javascript
app.addHook('feeder:auth', (auth, session, next) => {
    let err = new Error('Invalid password');
    err.responseCode = 535;
    next(err);
});
```

### _session_ object

`session` object is provided by feeder hooks. This is a state object provided by _smtp-server_ module, see details [here](https://github.com/andris9/smtp-server#session-object).

### _auth_ object

`auth` object is provided by the 'feeder:auth' hook and it includes credentials used for authentication.

- **username** includes the username provided by the client
- **password** includes the password provided by the client
- **method** provides the SMTP command used for authentication (eg. `'PLAIN'` or `'LOGIN'`)

### _address_ object

Address objects are provided by the envelope hooks (_feeder:mail_from_ and _feeder:rcpt_to_). This is not just an address but also any extension data provided by the client. The object includes the following properties:

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

`envelope` object includes all properties that get stored about the message to the queue. If you want to store your own data as well, you can edit the object, just do not put anything in it that can not be converted to JSON (circular references, host objects etc).

The object builds up in different steps, you can see the final envelope data in _message:store_ hook, until then some of the data is missing or might change.

- **id** is the queue ID for this message
- **from** email address from MAIL FROM
- **to** an array of email address strings from RCPT TO
- **origin** remote IP address of the connecting client
- **originhost** reverse resolved hostname of the client IP
- **transhost** hostname provided by EHLO or HELO command
- **transtype** transmission protocol (SMTP, ESTMP, ESTMPS, LMTP, HTTP etc.)
- **user** username of the authenticated user (if authentication is used)
- **time** date object of the envelope creation time
- **tls** cipher string if client is using secure connection
- **deferDelivery** timestamp in milliseconds for the minimal delivery time. The message is not sent out before this deadline
- **date** includes the value of the Date: header
- **from** the first address from the From: header (email address string without name part)
- **to** the addresses as an array from the To: header (email address strings without name part)
- **cc** the addresses as an array from the Cc: header (email address strings without name part)
- **bcc** the addresses as an array from the Bcc: header (email address strings without name part)
- **replyTo** the first address from the Reply-To: header (email address string without name part)
- **sender** the first address from the Sender: header (email address string without name part)
- **messageId** the Message-Id header value (eg. `<unique@domain>`)
- **sendingZone** the name of the sending zone to use (eg `'default'` or `'bounces'`)

### _headers_ object

`headers` allow you to list and manipulate headers of the message or a specific message node.

- **headers.get(key)** returns an array of strings with all header rows for the selected key (these are full header lines, so key name is part of the row string, eg. `["Subject: This is subject line"]`)
- **headers.getFirst(key)** returns string value of the specified header key (eg `"This is subject line"`)
- **headers.add(key, value [,index])** adds a new header value to the specified index or to the top of the header block if index is not specified
- **headers.update(key, value)** replaces a header value for the specified key
- **headers.delete(key)** remove header value for the specified key

## Using Message Analyzer

If you want to check the original data stream coming from the feeder you can process it with the analyzer hook. You can modify the data inside the hook but this affects the next analyzers as these get their input from the output of your hook

```javascript
app.addAnalyzerHook(handler);
```

Where

- **handler** is a function that processes the message stream. The function gets the following arguments:

  - **envelope** is an object with the sender and recipient info
  - **source** is a readable stream for that contains the data sent by client
  - **destination** is a writable stream where you must write the message stream. This becomes the input for the following stream handlers

If you want to

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

See example plugin [here](example-plugin.js)
