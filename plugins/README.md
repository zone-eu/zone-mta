# ZoneMTA plugins

This is the folder for plugins

Plugin files should expose a property called 'title' to identify themselves

Plugins should expose an `init` method. This method should register to all the required hooks

```
module.exports.init = function(app, next){
    // handle plugin initialization
    done();
};
```

Plugins are loaded in the order defined in `config.plugins` object

## Available hooks

- **feeder:mail_from** with arguments `address`, `session`
- **feeder:rcpt_to** with arguments `address`, `session`
- **feeder:auth** with arguments `auth`, `session`

See example plugin [here](example-plugin.js)
