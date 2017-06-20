'use strict';

const crypto = require('crypto');

// Set module title
module.exports.title = 'Image Hashes';

// Initialize the module
module.exports.init = (app, done) => {
    // This example calculates MD5 hash for every image in the message
    app.addStreamHook(
        (envelope, node) => /^(image|application)\//i.test(node.contentType),
        (envelope, node, source, done) => {
            let hash = crypto.createHash('md5');
            let filename = node.filename;
            let contentType = node.contentType;
            let bytes = 0;

            source.on('data', chunk => {
                bytes += chunk.length;
                hash.update(chunk);
            });

            source.on('end', () => {
                if (!envelope.attachments) {
                    envelope.attachments = [];
                }
                hash = hash.digest('hex');
                envelope.attachments.push({
                    name: filename,
                    type: contentType,
                    bytes,
                    hash
                });
                app.logger.info('ImageHash', '%s ATTACHMENT name="%s" type="%s" size=%s md5=%s', envelope.id, filename || '', contentType, bytes, hash);
                done();
            });
        }
    );

    // all set up regarding this plugin
    done();
};
