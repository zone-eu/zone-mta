'use strict';

// This plugin is disabled by default. See config.plugins to enable it
// The main objective for this plugin is to make sure that ./user is not empty (otherwise it would be excluded from git)

const Packer = require('zip-stream');
const crypto = require('crypto');

// Set module title
module.exports.title = 'ExamplePlugin';

// Initialize the module
module.exports.init = (app, done) => {
    // register a new hook for MAIL FROM command
    // if the hook returns an error, then sender address is rejected
    app.addHook('smtp:mail_from', (address, session, next) => {
        let mailFrom = ((address && address.address) || address || '').toString();
        if (mailFrom.length > 2048) {
            // respond with an error
            let err = new Error('Sender address is too long');
            err.responseCode = 452;
            return next(err);
        }
        // allow the message to pass
        return next();
    });

    app.addHook('message:headers', (envelope, messageInfo, next) => {
        if (/^Yes$/i.test(envelope.headers.getFirst('X-Block-Message'))) {
            let err = new Error('This message was blocked');
            err.responseCode = 500;
            return setTimeout(() => next(err), 10000);
        }

        // add a new header
        envelope.headers.add('X-Blocked', 'no');

        // allow the message to pass
        return next();
    });

    app.addRewriteHook(
        (envelope, node) => {
            // check if the node is text/html and is not an attachment
            if (node.contentType === 'text/html' && node.disposition !== 'attachment') {
                // we want to process this node
                return true;
            }
        },
        (envelope, node, decoder, encoder) => {
            // add an header for this node
            node.headers.add('X-Processed', 'yes');
            // you can read the contents of the node from `message` and write
            // the updated contents to the same object (it's a duplex stream)
            decoder.pipe(encoder);
        }
    );

    // This example calculates a md5 hash of the original unprocessed message
    // NB! this is not a good example stream-wise as it does not handle piping correctly
    app.addAnalyzerHook((envelope, source, destination) => {
        let hash = crypto.createHash('md5');

        source.on('data', chunk => {
            hash.update(chunk);
            destination.write(chunk);
        });

        source.on('end', () => {
            envelope.sourceMd5 = hash.digest('hex');
            destination.end();
        });
    });

    // This example converts all jpg images into zip compressed files
    app.addRewriteHook(
        (envelope, node) => node.contentType === 'image/jpeg',
        (envelope, node, source, destination) => {
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
            archive.entry(
                source,
                {
                    name: filename || 'image.jpg'
                },
                () => {
                    archive.finish();
                }
            );
        }
    );

    // This example calculates MD5 hash for every png image
    app.addStreamHook(
        (envelope, node) => node.contentType === 'image/png',
        (envelope, node, source, done) => {
            let hash = crypto.createHash('md5');
            source.on('data', chunk => hash.update(chunk));
            source.on('end', () => {
                app.logger.info('MD5', 'Calculated hash for "%s": %s', node.filename, hash.digest('hex'));
                done();
            });
        }
    );

    // all set up regarding this plugin
    done();
};
