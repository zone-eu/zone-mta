'use strict';

const fetch = require('nodemailer/lib/fetch');

module.exports.title = 'HTTP Bounce Notification';
module.exports.init = function(app, done) {
    // Send bounce notification to a HTTP url
    app.addHook('queue:bounce', (bounce, maildrop, next) => {
        let retries = 0;
        let body = {
            id: bounce.id,
            to: bounce.to,
            seq: bounce.seq,
            returnPath: bounce.from,
            category: bounce.category,
            time: bounce.time,
            response: bounce.response
        };

        let fbl = bounce.headers.getFirst('X-FBL');

        if (fbl) {
            body.fbl = fbl;
        }

        let notifyBounce = () => {
            // send bounce information
            let returned;
            let stream = fetch(app.config.url, {
                body
            });

            stream.on('readable', () => {
                while (stream.read() !== null) {
                    // ignore
                }
            });

            stream.once('error', err => {
                if (returned) {
                    return;
                }
                returned = true;
                app.logger.error('HTTPBounce[' + process.pid + ']', 'Could not send bounce info');
                app.logger.error('HTTPBounce[' + process.pid + ']', err.message);
                if (retries++ <= 5) {
                    setTimeout(notifyBounce, Math.pow(retries, 2) * 1000).unref();
                } else {
                    next();
                }
            });

            stream.on('end', () => {
                if (returned) {
                    return;
                }
                returned = true;
                next();
            });
        };

        setImmediate(notifyBounce);
    });

    done();
};
