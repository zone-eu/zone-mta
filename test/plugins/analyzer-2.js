'use strict';

module.exports.title = 'Analyzer Test 2';

module.exports.init = (app, done) => {
    app.addAnalyzerHook((envelope, source, destination) => {
        destination.write('X-Step-2: Analyzer\r\n');
        source.pipe(destination);
    });
    done();
};
