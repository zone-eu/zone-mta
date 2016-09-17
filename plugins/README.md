# ZoneMTA plugins

This is the folder for plugins. Files that reside here can be included in the main process. To enable a plugin edit [application configuration](../config/default.js) section "plugins" and add the plugin information into it.

Plugin files should expose a property called `title` to identify themselves. If title is not provided, then file name is used instead.

Plugins must expose an `init` method. This method should be used to register the plugin to all required hooks

```javascript
module.exports.title = 'My Awesome Plugin';
module.exports.init = function(app, next){
    // handle plugin initialization
    app.addHook(...);
    next();
};
```

Plugins are loaded in the order defined in `config.plugins` object

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
module.exports.init = function(app, next){
    console.log(app.config['my-value']); // 123
    next();
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

- **'feeder:mail_from'** with arguments `address`, `session`, called when MAIL FROM command is issued by the client
- **'feeder:rcpt_to'** with arguments `address`, `session`, called when RCPT TO command is issued by the client
- **'feeder:auth'** with arguments `auth`, `session`, called when AUTH command is issued by the client
- **'message:headers'** with arguments `envelope`, `headers`, called when rfc822 headers are found from the incoming message

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

## Using Message Rewriter

You can modify individual message nodes by setting up a message rewriter hook

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

**NB** once you have written something to the `encoder` stream, you can't modify node headers anymore. If you modify headers after writing data to the `message` stream you might run into race conditions where you can not know if the updated header data was actually used or not.

See example plugin [here](example-plugin.js)
