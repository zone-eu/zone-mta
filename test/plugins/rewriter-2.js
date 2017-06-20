'use strict';

module.exports.title = 'Rewriter Test 2';

module.exports.init = (app, done) => {
    app.addRewriteHook(
        (envelope, node) => node.contentType === 'text/plain',
        (envelope, node, source, destination) => {
            source.on('data', chunk => {
                // replace all O's with 0's
                destination.write(Buffer.from(chunk.toString().replace(/O/g, '0')));
            });
            source.on('end', () => destination.end());
        }
    );
    done();
};
