'use strict';

const fetch = require('nodemailer/lib/fetch');
const urllib = require('url');

module.exports.title = 'HTTP Basic Authorization';
module.exports.init = function(app, done) {
    // Listen for AUTH command
    // Make a Authorization:Basic call against an HTTP URL to authenticate an user
    app.addHook('smtp:auth', (auth, session, next) => {
        let urlparts = urllib.parse(app.config.url, true, true);

        urlparts.search = false;
        urlparts.query.transport = 'SMTP';
        urlparts.auth = encodeURIComponent(auth.username || '') + ':' + encodeURIComponent(auth.password || '');

        let returned = false;
        let req = fetch(urllib.format(urlparts));

        req.on('data', () => false); // ignore response data
        req.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            // do not provide any details about the failure
            err.message = new Error('Authentication failed');
            err.responseCode = 535;
            return next(err);
        });
        req.on('end', () => {
            if (returned) {
                return;
            }
            returned = true;
            // consider the authentication as succeeded as we did not get an error
            next();
        });
    });

    done();
};
