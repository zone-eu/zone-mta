'use strict';

// This plugin is disabled by default

// Set module title
module.exports.title = 'ExamplePlugin';

// Initialize the module
module.exports.init = (app, done) => {

    // register a new hook for MAIL FROM command
    // if the hook returns an error, then sender address is rejected
    app.addHook('feeder:mail_from', (address, session, next) => {
        let mailFrom = (address && address.address || address || '').toString();
        if (mailFrom.length > 2048) {
            // respond with an error
            let err = new Error('Sender address is too long');
            err.responseCode = 452;
            return next(err);
        }
        // allow the message to pass
        return next();
    });

    app.addHook('message:headers', (envelope, headers, next) => {

        if (/^Yes$/i.test(headers.getFirst('X-Block-Message'))) {
            let err = new Error('This message was blocked');
            err.responseCode = 500;
            return setTimeout(() => next(err), 10000);
        }

        // add a new header
        headers.add('X-Blocked', 'no');

        // allow the message to pass
        return next();
    });

    app.addRewriteHook((envelope, node) => {
        // check if the node is text/html and is not an attachment
        if (node.contentType === 'text/html' && node.disposition !== 'attachment') {
            // we want to process this node
            return true;
        }
    }, (envelope, node, message) => {
        // add an header for this node
        node.headers.add('X-Processed', 'yes');
        // you can read the contents of the node from `message` and write
        // the updated contents to the same object (it's a duplex stream)
        message.pipe(message);
    });

    // all set up regarding this plugin
    done();

};
