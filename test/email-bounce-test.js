'use strict';

const emailBounce = require('../plugins/core/email-bounce');

function createHeaders() {
    return {
        getFirst(key) {
            if (key === 'Message-ID') {
                return '<test-message@example.com>';
            }
            return '';
        },
        get(key) {
            if (key === 'Received') {
                return [];
            }
            return [];
        },
        build() {
            return 'Message-ID: <test-message@example.com>\r\n';
        }
    };
}

function createApp() {
    const hooks = new Map();
    return {
        hooks,
        config: {
            zoneConfig: {},
            mailerDaemon: 'Mailer Daemon <mailer-daemon@[HOSTNAME]>',
            sendingZone: 'default'
        },
        addHook(name, handler) {
            hooks.set(name, handler);
        },
        getQueue() {
            return {
                generateId(callback) {
                    callback(null, 'test-bounce-id');
                }
            };
        },
        logger: {
            info() {},
            error() {}
        },
        remotelog() {}
    };
}

module.exports['Email bounce hides original recipients when it matches the failed recipient'] = test => {
    const app = createApp();
    emailBounce.init(app, () => {});

    const queueBounce = app.hooks.get('queue:bounce');

    const bounce = {
        id: 'message-id',
        sessionId: 'session-id',
        zone: 'default',
        from: 'sender@example.com',
        to: [{ address: 'failed@example.com' }],
        seq: '001',
        headers: createHeaders(),
        name: 'mx.example.com',
        arrivalDate: new Date('2026-03-25T10:00:00Z').toISOString(),
        response: '550 5.1.1 No such user'
    };

    const maildrop = {
        add(envelope, stream, callback) {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('error', callback);
            stream.on('end', () => {
                const message = Buffer.concat(chunks).toString();

                test.equal(envelope.to, 'sender@example.com');
                test.ok(/Subject: Delivery Status Notification \(Failure: failed@example\.com\)/.test(message));
                test.ok(/Final-Recipient: rfc822; failed@example\.com/.test(message));
                test.ok(/X-Failed-Recipients: failed@example\.com/.test(message));
                test.ok(!/Original message recipients:\s+failed@example\.com/.test(message));

                callback();
            });
        }
    };

    queueBounce(bounce, maildrop, err => {
        test.ifError(err);
        test.done();
    });
};

module.exports['Email bounce includes original recipients when it differs from the failed recipient'] = test => {
    const app = createApp();
    emailBounce.init(app, () => {});

    const queueBounce = app.hooks.get('queue:bounce');

    const bounce = {
        id: 'message-id',
        sessionId: 'session-id',
        zone: 'default',
        from: 'sender@example.com',
        recipient: 'failed@example.com',
        to: [{ address: 'first@example.com' }, { address: 'failed@example.com' }],
        seq: '001',
        headers: createHeaders(),
        name: 'mx.example.com',
        arrivalDate: new Date('2026-03-25T10:00:00Z').toISOString(),
        response: '550 5.1.1 No such user'
    };

    const maildrop = {
        add(envelope, stream, callback) {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('error', callback);
            stream.on('end', () => {
                const message = Buffer.concat(chunks).toString();

                test.equal(envelope.to, 'sender@example.com');
                test.ok(/Subject: Delivery Status Notification \(Failure: failed@example\.com\)/.test(message));
                test.ok(/Final-Recipient: rfc822; failed@example\.com/.test(message));
                test.ok(/X-Failed-Recipients: first@example\.com, failed@example\.com/.test(message));
                test.ok(/Original message recipients:\s+first@example\.com\s+failed@example\.com/.test(message));

                callback();
            });
        }
    };

    queueBounce(bounce, maildrop, err => {
        test.ifError(err);
        test.done();
    });
};
