'use strict';

module.exports.title = 'Rewriter Test 1';

module.exports.init = (app, done) => {
    app.addRewriteHook(
        (envelope, node) => node.contentType === 'text/plain',
        (envelope, node, source, destination) => {
            source.on('data', chunk => {
                // convert all chars to uppercase
                destination.write(Buffer.from(chunk.toString().toUpperCase()));
            });
            source.on('end', () => {
                destination.end();
            });
        }
    );
    done();
};
