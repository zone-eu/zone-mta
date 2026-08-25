'use strict';

const SMTPProxy = require('../lib/receiver/smtp-proxy');
const captureLogs = require('./fixtures/capture-logs');

// A socket handed to the proxy before it ever reaches an SMTP server. Nothing else records
// these connections, so socketEnd is the only place the refusal can be logged.
function fakeSocket() {
    let socket = {
        remoteAddress: '203.0.113.10',
        written: false,
        end(data) {
            socket.written = data;
        },
        destroy() {
            socket.destroyed = true;
        }
    };
    return socket;
}

module.exports['SMTP proxy logs connections it refuses'] = test => {
    captureLogs(entries => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        let socket = fakeSocket();

        proxy.socketEnd(socket, '421 No free process to handle connection');

        test.equal(socket.written, '421 No free process to handle connection\r\n');
        test.equal(entries.length, 1);
        test.equal(entries[0].level, 'info');
        test.equal(entries[0].prefix, proxy.logName);
        test.equal(entries[0].message, 'SMTPREJECT src=203.0.113.10 response="421 No free process to handle connection"');
    });
    test.done();
};

module.exports['SMTP proxy logs the refusal of a shutting down server'] = test => {
    captureLogs(entries => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        proxy.closing = true;
        let socket = fakeSocket();

        proxy.connection(socket);

        test.equal(socket.written, '421 Server shutting down\r\n');
        test.equal(entries.length, 1);
        test.ok(/SMTPREJECT src=203\.0\.113\.10 response="421 Server shutting down"/.test(entries[0].message));
    });
    test.done();
};

module.exports['SMTP proxy logs the refusal when no receiver process is available'] = test => {
    captureLogs(entries => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        let socket = fakeSocket();

        proxy.connection(socket);

        test.equal(socket.written, '421 No free process to handle connection\r\n');
        test.equal(entries.length, 1);
        test.ok(/response="421 No free process to handle connection"/.test(entries[0].message));
    });
    test.done();
};
