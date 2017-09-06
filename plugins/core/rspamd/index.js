'use strict';

const RspamdClient = require('./rspamd-client');

module.exports.title = 'Rspamd Spam Check';
module.exports.init = function(app, done) {
    app.addAnalyzerHook((envelope, source, destination) => {
        let interfaces = Array.isArray(app.config.interfaces) ? app.config.interfaces : [].concat(app.config.interfaces || []);
        if (!interfaces.includes(envelope.interface) && !interfaces.includes('*')) {
            return source.pipe(destination);
        }

        let rspamdStream = new RspamdClient({
            url: app.config.url,
            from: envelope.from,
            to: envelope.to,
            user: envelope.user,
            id: envelope.id,
            maxSize: app.config.maxSize,
            ip: app.config.ip === true ? app.envelope.origin : app.config.ip
        });

        rspamdStream.on('fail', err => {
            app.logger.info('Rspamd', '%s SKIPPED "%s" (from=%s to=%s)', envelope.id, err.message, envelope.from, [].concat(envelope.to || []).join(','));
        });

        rspamdStream.on('response', response => {
            // store spam result to the envelope
            envelope.spam = response;
            let score = (Number(response && response.default && response.default.score) || 0).toFixed(2);
            let tests = [].concat((response && response.tests) || []).join(', ');
            let action = (response && response.default && response.default.action) || 'unknown';
            app.logger.info('Rspamd', '%s RESULTS score=%s action="%s" [%s]', envelope.id, score, action, tests);

            app.remotelog(envelope.id, false, 'SPAMCHECK', {
                score,
                result: action,
                tests
            });
        });

        rspamdStream.once('error', err => {
            source.emit('error', err);
        });

        let finished = false;
        let reading = false;
        let readNext = () => {
            let chunk = source.read();
            if (chunk === null) {
                if (finished) {
                    rspamdStream.end();
                }
                reading = false;
                return;
            }
            if (!rspamdStream.write(chunk)) {
                return rspamdStream.once('drain', readNext);
            }
            readNext();
        };

        source.on('readable', () => {
            if (reading) {
                return;
            }
            reading = true;
            readNext();
        });

        source.once('end', () => {
            finished = true;
            if (reading) {
                return;
            }
            rspamdStream.end();
        });

        rspamdStream.pipe(destination);
    });

    app.addHook('message:queue', (envelope, messageInfo, next) => {
        let interfaces = Array.isArray(app.config.interfaces) ? app.config.interfaces : [].concat(app.config.interfaces || []);
        if ((!interfaces.includes(envelope.interface) && !interfaces.includes('*')) || !envelope.spam || !envelope.spam.default) {
            return next();
        }

        let score = Number(envelope.spam.default.score) || 0;
        score = Math.round(score * 100) / 100;

        messageInfo.tests = envelope.spam.tests.join(',');
        messageInfo.score = score.toFixed(2);

        if (!app.config.ignoreOrigins.includes(envelope.origin) && !envelope.ignoreSpamScore) {
            switch (envelope.spam.default.action) {
                case 'reject':
                    if (app.config.dropSpam) {
                        // accept message and silently drop it
                        return next(app.drop(envelope, 'spam', messageInfo));
                    }
                    // reject spam
                    return next(app.reject(envelope, 'spam', messageInfo, '550 This message was classified as SPAM and may not be delivered'));
                case 'add header':
                case 'rewrite subject':
                case 'soft reject':
                    if (app.config.rewriteSubject) {
                        let subject = envelope.headers.getFirst('subject');
                        subject = ('[***SPAM(' + score.toFixed(2) + ')***] ' + subject).trim();
                        envelope.headers.update('Subject', subject);
                    }
                    break;
            }
        }

        next();
    });

    app.addHook('sender:headers', (delivery, connection, next) => {
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

            delivery.headers.add('X-Zone-Spam-Resolution', delivery.spam.default.action, Infinity);
            delivery.headers.add(
                'X-Zone-Spam-Status',
                (delivery.spam.default.is_spam ? 'Yes' : 'No') + (statusParts.length ? ', ' + statusParts.join(', ') : ''),
                Infinity
            );
        }
        next();
    });

    done();
};
