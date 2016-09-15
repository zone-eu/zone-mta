'use strict';

// This plugin is disabled by default. See config.plugins to enable it

const Packer = require('zip-stream');

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
    }, (envelope, node, decoder, encoder) => {
        // add an header for this node
        node.headers.add('X-Processed', 'yes');
        // you can read the contents of the node from `message` and write
        // the updated contents to the same object (it's a duplex stream)
        decoder.pipe(encoder);
    });


    // This example converts all jpg images into zip compressed files
    app.addRewriteHook((envelope, node) => node.contentType === 'image/jpeg', (envelope, node, source, destination) => {

        let archive = new Packer();

        // update content type of the resulting mime node
        node.setContentType('application/zip');

        // update filename (if set), replace the .jpeg extension with .zip
        let filename = node.filename;
        if (filename) {
            let newFilename = node.filename.replace(/\.jpe?g$/i, '.zip');
            node.setFilename(newFilename);
        }

        archive.pipe(destination);
        archive.entry(source, {
            name: filename || 'image.jpg'
        }, () => {
            archive.finish();
        });
    });

    // all set up regarding this plugin
    done();

};
