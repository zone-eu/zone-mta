'use strict';

const SRS = require('srs.js');

module.exports.title = 'SRS Rewriter';
module.exports.init = function(app, done) {
    const srsRewriter = new SRS({
        secret: app.config.secret
    });

    app.addHook('sender:headers', (delivery, connection, next) => {
        if (delivery.envelope.from) {
            let from = delivery.envelope.from;
            let domain = from.substr(from.lastIndexOf('@') + 1).toLowerCase();
            if (!app.config.excludeDomains.includes(domain) && domain !== app.config.rewriteDomain) {
                delivery.envelope.from = srsRewriter.rewrite(from.substr(0, from.lastIndexOf('@')), domain) + '@' + app.config.rewriteDomain;
            }
        }
        next();
    });

    done();
};
