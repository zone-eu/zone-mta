'use strict';

const mailcomposer = require('mailcomposer');
const Headers = require('mailsplit').Headers;

module.exports.title = 'Email Bounce Notification';
module.exports.init = function (app, done) {

    // Send bounce notification to the MAIL FROM email
    app.addHook('queue:bounce', (bounce, maildrop, next) => {
        if (!bounce.from) {
            // nowhere to send the bounce to
            return next();
        }

        let headers = new Headers(bounce.headers);

        if (headers.get('Received').length > 25) {
            // too many hops
            app.logger.info('Bounce', 'Too many hops (%s)! Delivery loop detected for %s.%s, dropping message', headers.get('Received').length, bounce.seq, bounce.id);
            return next();
        }

        let envelope = {
            interface: 'bounce',
            from: '',
            to: bounce.from,
            transtype: 'HTTP',
            time: Date.now()
        };

        let mail = mailcomposer({
            from: app.config.mailerDaemon,
            to: bounce.from,
            headers: {
                'X-Sending-Zone': app.config.sendingZone,
                'X-Failed-Recipients': bounce.to,
                'Auto-Submitted': 'auto-replied'
            },
            subject: 'Delivery Status Notification (Failure)',
            text: 'Delivery to the following recipient failed permanently:\n    ' + bounce.to + '\n\n' +
                'Technical details of permanent failure:\n\n' + bounce.response + '\n\n\n----- Original message -----\n' +
                headers.build().toString().trim() + '\n\n----- Message truncated -----'
        });

        app.getQueue().generateId((err, id) => {
            if (err) {
                return next(err);
            }
            envelope.id = id;

            maildrop.add(envelope, mail.createReadStream(), err => {
                if (err && err.name !== 'SMTPResponse') {
                    app.logger.error('Bounce', err.message);
                }
                next();
            });
        });
    });

    done();
};
