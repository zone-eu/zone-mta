'use strict';

// Set module title
module.exports.title = 'DeliveryLoop';

// Initialize the module
module.exports.init = (app, done) => {
    const MAX_HOPS = app.config.maxHops || 25;

    app.addHook('message:headers', (envelope, messageInfo, next) => {
        let receivedLength = envelope.headers.get('Received').length;

        if (receivedLength > MAX_HOPS) {
            // too many hops
            app.logger.info('DeliveryLoop', 'Too many hops (%s)! Delivery loop detected for %s, rejecting message', receivedLength, envelope.id);
            let err = new Error(`A delivery loop was detected which causes this email which caused the email to be undeliverable (${receivedLength})`);
            err.name = 'SMTPResponse';
            err.responseCode = 500;
            return next(err);
        }

        // allow the message to pass
        return next();
    });

    // all set up regarding this plugin
    done();
};
