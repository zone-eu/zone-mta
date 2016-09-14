'use strict';

// Module

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
        if(node.contentType === 'text/html' && node.disposition !== 'attachment'){
            // we want to process this node
            return true;
        }
    }, (envelope, data) => {
        // add an header for this node
        data.node.headers.add('X-Processed', 'yes');
        // If you want to process the data, then decoder is a stream (Buffer) of node data as a raw bytestream.
        // Once you have finished with the data pass it over to the decoder as is, no not apply any
        // transfer encoding to the data yourself
        data.decoder.pipe(data.encoder);
    });

    // all set up regarding this plugin
    done();

};
