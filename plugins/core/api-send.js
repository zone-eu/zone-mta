'use strict';

module.exports.title = 'API Mail Checks';
module.exports.init = function(app, done) {
    // Called when a mail is dropped to HTTP
    app.addHook('api:mail', (envelope, session, next) => {
        if (app.config.maxRecipients && Array.isArray(envelope.to) && envelope.to.length >= app.config.maxRecipients) {
            let err = new Error('Too many recipients: ' + envelope.to.length + ' provided, ' + app.config.maxRecipients + ' allowed');
            return next(err);
        }
        next();
    });

    done();
};
