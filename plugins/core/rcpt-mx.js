'use strict';

const iptools = require('../../lib/iptools');

module.exports.title = 'Recipient MX Check';
module.exports.init = function(app, done) {
    app.addHook('smtp:rcpt_to', (address, session, next) => {
        let email = address.address;
        iptools.resolveMx(email.substr(email.lastIndexOf('@') + 1), false, (err, list) => {
            if (err || !list) {
                let err = new Error('Can\'t find an MX server for <' + email + '>');
                err.responseCode = 550;
                return setImmediate(() => next(err));
            }
            setImmediate(next);
        });
    });

    done();
};
