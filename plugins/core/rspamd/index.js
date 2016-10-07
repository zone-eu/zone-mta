'use strict';

const RspamdClient = require('./rspamd-client');

module.exports.title = 'Rspamd Spam Check';
module.exports.init = function (app, done) {

    app.addAnalyzerHook((envelope, source, destination) => {
        if (!app.config.interfaces.includes(envelope.interface)) {
            return source.pipe(destination);
        }

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
            source.emit('error', err);
        });

        source.pipe(rspamdStream).pipe(destination);
    });

    app.addHook('message:queue', (envelope, next) => {
        if (!app.config.interfaces.includes(envelope.interface)) {
            return next();
        }

        if (app.config.processSpam) {
            switch (envelope.spam && envelope.spam.default && envelope.spam.default.action) {
                case 'reject':
                    app.logger.info('Queue', '%s DROPPED[spam] (message-id=%s from=%s to=%s)', envelope.id, envelope.messageId, envelope.from, envelope.to.join(','));
                    // accept message and silently drop it
                    next({
                        name: 'SMTPResponse',
                        message: 'Message accepted'
                    });
                    break;
                case 'add header':
                case 'rewrite subject':
                case 'soft reject':
                    {
                        let subject = envelope.headers.getFirst('subject');
                        let score = Number(envelope.spam.default.score) || 0;
                        score = Math.round(score * 100) / 100;
                        subject = ('[*** SPAM ' + score + ' ***] ' + subject).trim();
                        envelope.headers.update('Subject', subject);
                        break;
                    }
            }
        }

        if (app.config.rejectSpam && envelope.spam && envelope.spam.default && envelope.spam.default.is_spam) {
            let err = new Error('This message was classified as SPAM and may not be delivered');
            err.responseCode = 550;
            app.logger.info('Rspamd', '%s NOQUEUE spam score %s, tests=[%s] (from=%s to=%s)', envelope.id, envelope.spam.default.score, envelope.spam.tests.join(','), envelope.from, envelope.to.join(','));
            return next(err);
        }
        next();
    });

    app.addHook('sender:headers', (delivery, next) => {
        if (delivery.spam && delivery.spam.default) {

            // insert spam headers to the bottom of the header section
            let statusParts = [];

            // This is ougtgoing message so the recipient would have exactly 0 reasons to trust our
            // X-Spam-* headers, thus we use custom headers X-Zone-Spam-* and these are for debugging
            // purposes only

            if ('score' in delivery.spam.default) {
                statusParts.push('score=' + delivery.spam.default.score);
            }

            if ('required_score' in delivery.spam.default) {
                statusParts.push('required=' + delivery.spam.default.required_score);
            }

            if (Array.isArray(delivery.spam.tests) && delivery.spam.tests.length) {
                statusParts.push('tests=[' + delivery.spam.tests.join(', ') + ']');
            }

            delivery.headers.add('X-Zone-Spam-Status', (delivery.spam.default.is_spam ? 'Yes' : 'No') + (statusParts.length ? ', ' + statusParts.join(', ') : ''), Infinity);

        }
        next();
    });

    done();
};
