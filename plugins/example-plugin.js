'use strict';

// Module

// Set module title
module.exports.title = 'ExamplePlugin';

// Initialize the module
module.exports.init = (app, done) => {

    // register a new hook for MAIL FROM command
    // if the hook returns an error, then sender address is rejected
    app.addHook('feeder:mail_from', (address, session, next) => {
        let mailFrom = (address && address.address || address || '').toString();
        if (mailFrom.length > 2048) {
            // respond with an error
            let err = new Error('Sender address is too long');
            err.responseCode = 452;
            return next(err);
        }
        // allow the message to pass
        return next();
    });

    // all set up regarding this plugin
    done();

};
