'use strict';

module.exports.title = 'Analyzer Readable';

// Copies the message the way a scanning plugin would: reads through 'readable' and honours backpressure
module.exports.init = (app, done) => {
    app.addAnalyzerHook((envelope, source, destination) => {
        let waiting = false;
        let pump = () => {
            if (waiting) {
                return;
            }
            let chunk;
            while ((chunk = source.read()) !== null) {
                if (!destination.write(chunk)) {
                    waiting = true;
                    destination.once('drain', () => {
                        waiting = false;
                        pump();
                    });
                    return;
                }
            }
        };
        source.on('readable', pump);
        source.on('end', () => destination.end());
    });
    done();
};
