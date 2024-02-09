'use strict';

const os = require('os');
const MimeNode = require('nodemailer/lib/mime-node');

module.exports.title = 'Email Bounce Notification';
module.exports.init = function (app, done) {
    // generate a multipart/report DSN failure response
    function generateBounceMessage(bounce, opts) {
        opts = opts || {};
        const { isDelayed } = opts;

        let headers = bounce.headers;
        let messageId = headers.getFirst('Message-ID');

        let cfg = app.config.zoneConfig[bounce.zone];
        if (!cfg || cfg.disabled) {
            cfg = {};
        }

        let from = cfg.mailerDaemon || app.config.mailerDaemon;
        let to = bounce.from;
        let sendingZone = cfg.sendingZone || app.config.sendingZone;

        let rootNode = new MimeNode('multipart/report; report-type=delivery-status');

        // format Mailer Daemon address
        let fromAddress = rootNode._convertAddresses(rootNode._parseAddresses(from)).replace(/\[HOSTNAME\]/gi, bounce.name || os.hostname());

        rootNode.setHeader('From', fromAddress);
        rootNode.setHeader('To', to);
        rootNode.setHeader('X-Sending-Zone', sendingZone);
        rootNode.setHeader('X-Failed-Recipients', bounce.to);
        rootNode.setHeader('Auto-Submitted', 'auto-replied');
        rootNode.setHeader('Subject', `Delivery Status Notification (${isDelayed ? 'Delay' : 'Failure'})`);

        if (messageId) {
            rootNode.setHeader('In-Reply-To', messageId);
            rootNode.setHeader('References', messageId);
        }

        let bounceContent = `Delivery to the following recipient failed permanently:
    ${bounce.to}

Technical details of permanent failure:

${bounce.response}

`;

        if (isDelayed) {
            bounceContent = `Delivery incomplete

There was a temporary problem delivering your message to ${bounce.to}.

Delivery will be retried. You'll be notified if the delivery fails permanently.

Technical details of the failure:

${bounce.response}

`;
        }

        rootNode.createChild('text/plain').setHeader('Content-Description', 'Notification').setContent(bounceContent);

        rootNode
            .createChild('message/delivery-status')
            .setHeader('Content-Description', 'Delivery report')
            .setContent(
                `Reporting-MTA: dns; ${bounce.name || os.hostname()}
X-ZoneMTA-Queue-ID: ${bounce.id}
X-ZoneMTA-Sender: rfc822; ${bounce.from}
Arrival-Date: ${new Date(bounce.arrivalDate).toUTCString().replace(/GMT/, '+0000')}

Final-Recipient: rfc822; ${bounce.to}
Action: ${isDelayed ? 'delayed' : 'failed'}
Status: ${isDelayed ? '4.0.0' : '5.0.0'}
` +
                    (bounce.mxHostname
                        ? `Remote-MTA: dns; ${bounce.mxHostname}
`
                        : '') +
                    `Diagnostic-Code: smtp; ${bounce.response}

`
            );

        rootNode.createChild('text/rfc822-headers').setHeader('Content-Description', 'Undelivered Message Headers').setContent(headers.build());

        return rootNode;
    }

    // Send bounce notification to the MAIL FROM email
    app.addHook('queue:bounce', (bounce, maildrop, next) => {
        if ((app.config.disableInterfaces || []).includes(bounce.interface)) {
            // bounces are disabled for messages from this interface (eg. forwarded messages)
            return next();
        }

        if (!bounce.from) {
            // nowhere to send the bounce to
            return next();
        }

        let headers = bounce.headers;

        if (headers.get('Received').length > 25) {
            // too many hops
            app.logger.info(
                'Bounce',
                'Too many hops (%s)! Delivery loop detected for %s.%s, dropping message',
                headers.get('Received').length,
                bounce.seq,
                bounce.id
            );
            return next();
        }

        let envelope = {
            interface: 'bounce',
            sessionId: bounce.sessionId,
            from: '',
            to: bounce.from,
            transtype: 'HTTP',
            time: Date.now()
        };

        let mail = generateBounceMessage(bounce);

        app.getQueue().generateId((err, id) => {
            if (err) {
                return next(err);
            }
            envelope.id = id;

            maildrop.add(envelope, mail.createReadStream(), err => {
                if (err && err.name !== 'SMTPResponse') {
                    app.logger.error('Bounce', err.message);
                    app.remotelog(bounce.id, bounce.seq, 'QUEUE_BOUNCE', {
                        queued: 'no',
                        bounceType: 'failure',
                        error: err.message
                    });
                } else {
                    app.remotelog(bounce.id, bounce.seq, 'QUEUE_BOUNCE', {
                        queued: 'yes',
                        bounceType: 'failure',
                        bounceId: envelope.id
                    });
                }

                next();
            });
        });
    });

    app.addHook('queue:delayed', async (bounce, maildrop, options) => {
        if (!app.config.delayEmail || !app.config.delayEmail.enabled) {
            return;
        }

        if ((app.config.disableInterfaces || []).includes(bounce.interface)) {
            // bounces are disabled for messages from this interface (eg. forwarded messages)
            return;
        }

        if (!bounce.from) {
            // nowhere to send the bounce to
            return;
        }

        // check if past required time
        const prevDiff = options.prev - options.first;
        const curDiff = options.last - options.first;
        if (prevDiff > app.config.delayEmail.after || curDiff < app.config.delayEmail.after) {
            return;
        }

        const headers = bounce.headers;

        if (headers.get('Received').length > 25) {
            // too many hops
            app.logger.info(
                'Bounce',
                'Too many hops (%s)! Delivery loop detected for %s.%s, dropping message',
                headers.get('Received').length,
                bounce.seq,
                bounce.id
            );
            return;
        }

        const envelope = {
            interface: 'bounce',
            sessionId: bounce.sessionId,
            from: '',
            to: bounce.from,
            transtype: 'HTTP',
            time: Date.now()
        };

        const mail = generateBounceMessage(bounce, { isDelayed: true });

        let id = await new Promise((resolve, reject) => {
            app.getQueue().generateId((err, id) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(id);
                }
            });
        });

        envelope.id = id;

        await new Promise(resolve => {
            maildrop.add(envelope, mail.createReadStream(), err => {
                if (err && err.name !== 'SMTPResponse') {
                    app.logger.error('Bounce', err.message);
                    app.remotelog(bounce.id, bounce.seq, 'QUEUE_BOUNCE', {
                        queued: 'no',
                        bounceType: 'delayed',
                        error: err.message
                    });
                } else {
                    app.remotelog(bounce.id, bounce.seq, 'QUEUE_BOUNCE', {
                        queued: 'yes',
                        bounceType: 'delayed',
                        bounceId: envelope.id
                    });
                }

                resolve();
            });
        });
    });

    done();
};
