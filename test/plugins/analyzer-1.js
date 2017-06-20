'use strict';

module.exports.title = 'Analyzer Test 1';

module.exports.init = (app, done) => {
    app.addAnalyzerHook((envelope, source, destination) => {
        destination.write('X-Step-1: Analyzer\r\n');
        source.pipe(destination);
    });
    done();
};
