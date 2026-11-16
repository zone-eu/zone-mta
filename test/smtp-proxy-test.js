'use strict';

const test = require('node:test');
const assert = require('node:assert');

const EventEmitter = require('events');
const SMTPProxy = require('../lib/receiver/smtp-proxy');
const captureLogs = require('./fixtures/capture-logs');

// A socket handed to the proxy before it ever reaches an SMTP server. Nothing else records
// these connections, so socketEnd is the only place the refusal can be logged. It is an
// EventEmitter because the proxy attaches an 'error' listener to it: a reset peer surfaces as
// an asynchronous 'error', not a synchronous throw, so the socket must never be held without
// one.
function fakeSocket() {
    let socket = new EventEmitter();
    socket.remoteAddress = '203.0.113.10';
    socket.written = false;
    socket.end = data => {
        socket.written = data;
    };
    socket.destroy = () => {
        socket.destroyed = true;
    };
    return socket;
}

test('SMTP proxy logs connections it refuses', () => {
    captureLogs(entries => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        let socket = fakeSocket();

        proxy.socketEnd(socket, '421 No free process to handle connection');

        assert.equal(socket.written, '421 No free process to handle connection\r\n');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].level, 'info');
        assert.equal(entries[0].prefix, proxy.logName);
        assert.equal(entries[0].message, 'SMTPREJECT src=203.0.113.10 response="421 No free process to handle connection"');
    });
});

test('SMTP proxy logs the refusal of a shutting down server', () => {
    captureLogs(entries => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        proxy.closing = true;
        let socket = fakeSocket();

        proxy.connection(socket);

        assert.equal(socket.written, '421 Server shutting down\r\n');
        assert.equal(entries.length, 1);
        assert.ok(/SMTPREJECT src=203\.0\.113\.10 response="421 Server shutting down"/.test(entries[0].message));
    });
});

test('SMTP proxy logs the refusal when no receiver process is available', () => {
    captureLogs(entries => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        let socket = fakeSocket();

        proxy.connection(socket);

        assert.equal(socket.written, '421 No free process to handle connection\r\n');
        assert.equal(entries.length, 1);
        assert.ok(/response="421 No free process to handle connection"/.test(entries[0].message));
    });
});

// Regression: a peer that resets the connection while it is being refused emits an
// asynchronous 'error' on the socket. socketEnd() must attach an 'error' listener before it
// writes the reply, otherwise the emit has no listener and Node turns it into an unhandled
// 'error' that crashes the whole proxy process (the try/catch around socket.end() only covers
// synchronous throws). Emitting 'error' here throws unless the listener is in place.
test('SMTP proxy survives a socket error while refusing a connection', () => {
    captureLogs(() => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        let socket = fakeSocket();

        proxy.socketEnd(socket, '421 No free process to handle connection');

        assert.doesNotThrow(() => socket.emit('error', new Error('write ECONNRESET')));
    });
});

// Regression: connection() must guard the socket the instant it is accepted, before any
// handoff or refusal, so a reset in the accept→handoff window cannot crash the proxy.
test('SMTP proxy survives a socket error during handoff', () => {
    captureLogs(() => {
        let proxy = new SMTPProxy('feeder', { name: 'feeder' });
        let socket = fakeSocket();
        let readStopped = false;
        let sentMessage;
        let sentSocket;

        socket._handle = {
            readStop() {
                readStopped = true;
            }
        };
        proxy.children.add({
            send(message, passedSocket) {
                sentMessage = message;
                sentSocket = passedSocket;
                return true;
            }
        });

        assert.equal(proxy.connection(socket), true);
        assert.equal(readStopped, true);
        assert.equal(sentMessage, 'socket');
        assert.strictEqual(sentSocket, socket);
        assert.equal(socket.written, false);

        assert.doesNotThrow(() => socket.emit('error', new Error('write ECONNRESET')));
    });
});
