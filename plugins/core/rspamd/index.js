'use strict';

const RspamdClient = require('./rspamd-client');

module.exports.title = 'Rspamd Spam Check';
module.exports.init = function (app, done) {

    app.addAnalyzerHook((envelope, source, destination) => {
        let rspamdStream = new RspamdClient({
            url: app.config.url,
            from: envelope.from,
            to: envelope.to,
            user: envelope.user,
            id: envelope.id
        });

        rspamdStream.on('fail', err => {
            app.logger.error('Rspamd', err);
        });

        rspamdStream.on('response', response => {
            // store spam result to the envelope
            envelope.spam = response;
        });

        rspamdStream.once('error', err => {
            destination.emit('error', err);
        });

        source.pipe(rspamdStream).pipe(destination);
    });

    app.addHook('message:store', (envelope, headers, next) => {
        if (app.config.rejectSpam && envelope.spam && envelope.spam.default && envelope.spam.default.is_spam) {
            let err = new Error('This message was classified as SPAM and may not be delivered');
            err.responseCode = 550;
            app.logger.info('Feeder', 'REJECTED as spam %s: score %s, tests=[%s] (From: %s; To: %s)', envelope.messageId || envelope.id, envelope.spam.default.score, envelope.spam.tests.join(','), envelope.from, envelope.to.join(','));
            return next(err);
        }
        next();
    });

    done();
};
