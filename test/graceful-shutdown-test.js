'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Covers the notify + drain primitives the graceful-shutdown wiring relies on:
//   - SendingZone.close() / closeSenders()  -> IPC { shutdown: true } to sender children
//   - SMTPProxy.closeChildren()             -> IPC { shutdown: true } to receiver children
//   - SMTPInterface.close()                 -> wait for proxy-worker SMTP sessions
//   - Sender.close() + sendNext()           -> the 'closed' drain handshake
// The actual process.on('message', ...) handlers in services/sender.js and
// services/receiver.js run as forked child processes and can't be required in-process,
// so this only exercises the building blocks they call.

const EventEmitter = require('events');
const childProcess = require('child_process');
const sendingZoneModule = require('../lib/sending-zone');
const { SendingZone } = sendingZoneModule;
const SMTPProxy = require('../lib/receiver/smtp-proxy');
const SMTPInterface = require('../lib/smtp-interface');
const Sender = require('../lib/sender');
const Headers = require('@zone-eu/mailsplit').Headers;

// A fake forked child: records what was sent over the IPC channel. throwOnSend and
// callbackError cover the synchronous and asynchronous failure modes of ChildProcess.send().
function makeChild(throwOnSend, callbackError) {
    let sent = [];
    return {
        connected: true,
        sent,
        send(msg, callback) {
            if (throwOnSend) {
                throw new Error('channel closed');
            }
            sent.push(msg);
            if (callbackError) {
                return callback(new Error('channel closed asynchronously'));
            }
        }
    };
}

test('SendingZone.close() sends shutdown to every sender child', () => {
    let zone = Object.create(SendingZone.prototype);
    let c1 = makeChild();
    let c2 = makeChild();
    zone.children = new Set([c1, c2]);

    zone.close();

    assert.deepEqual(c1.sent, [{ shutdown: true }]);
    assert.deepEqual(c2.sent, [{ shutdown: true }]);
});

test('SendingZone.close() survives a dead IPC channel and still notifies the rest', () => {
    // send() can fail synchronously or through its callback, neither may abort the loop.
    // Insertion order is iteration order: the dead child goes first, so if the failure were
    // not handled the alive child would never be notified.
    [makeChild(true), makeChild(false, true)].forEach(dead => {
        let zone = Object.create(SendingZone.prototype);
        let alive = makeChild();
        zone.children = new Set([dead, alive]);

        assert.doesNotThrow(() => zone.close());
        assert.deepEqual(alive.sent, [{ shutdown: true }]);
    });
});

test('closeSenders() calls close() on every registered zone', () => {
    let goodClosed = 0;
    let badClosed = 0;
    sendingZoneModule.sendingZonelist.set('good', { close: () => goodClosed++ });
    sendingZoneModule.sendingZonelist.set('bad', { close: () => badClosed++ });

    try {
        sendingZoneModule.closeSenders();

        assert.equal(goodClosed, 1);
        assert.equal(badClosed, 1);
    } finally {
        // shared module level state, a failing assertion must not leave the fakes behind
        sendingZoneModule.sendingZonelist.delete('good');
        sendingZoneModule.sendingZonelist.delete('bad');
    }
});

test('SMTPProxy.closeChildren() sets closing and notifies every receiver child', () => {
    let proxy = Object.create(SMTPProxy.prototype);
    proxy.closing = false;
    let c1 = makeChild();
    let c2 = makeChild();
    proxy.children = new Set([c1, c2]);

    proxy.closeChildren();

    // `closing` must be set so the 'close' handler treats the exit as expected (no error log,
    // no respawn).
    assert.equal(proxy.closing, true);
    assert.deepEqual(c1.sent, [{ shutdown: true }]);
    assert.deepEqual(c2.sent, [{ shutdown: true }]);
});

test('SMTPInterface.close() waits for proxy-worker SMTP sessions', (_t, finishTest) => {
    let smtpInterface = Object.create(SMTPInterface.prototype);
    let connection = {};
    let connections = new Set([connection]);
    let nativeCloseCalled = false;
    smtpInterface.closing = false;
    smtpInterface.server = {
        server: { listening: false },
        connections,
        close() {
            nativeCloseCalled = true;
        }
    };

    let callbackCalled = false;
    smtpInterface.close(() => {
        callbackCalled = true;
        // the native close() reports success while sessions are still open, see close()
        assert.equal(nativeCloseCalled, false);
        finishTest();
    });

    // `closing` must be set right away so that the sessions that are still open start
    // rejecting new mail transactions while the rest of them finishes up.
    assert.equal(smtpInterface.closing, true);
    assert.equal(callbackCalled, false);
    setTimeout(() => connections.delete(connection), 10);
});

test('SendingZone.spawnSender() does not fork after shutdown starts', (_t, finishTest) => {
    let zone = Object.create(SendingZone.prototype);
    zone.queue = { closing: true };
    zone.children = new Set();
    let originalFork = childProcess.fork;
    let forkCalled = false;
    childProcess.fork = () => {
        forkCalled = true;
    };

    try {
        // the guard returns before forking, so the callback runs after fork is restored
        zone.spawnSender(() => {
            assert.equal(forkCalled, false);
            assert.equal(zone.children.size, 0);
            finishTest();
        });
    } finally {
        childProcess.fork = originalFork;
    }
});

test('SMTPProxy.spawnReceiver() does not fork after shutdown starts', () => {
    let proxy = Object.create(SMTPProxy.prototype);
    proxy.closing = true;
    proxy.children = new Set();
    proxy.processes = 1;
    let originalFork = childProcess.fork;
    let forkCalled = false;
    childProcess.fork = () => {
        forkCalled = true;
    };

    assert.equal(proxy.spawnReceiver(), false);
    childProcess.fork = originalFork;
    assert.equal(forkCalled, false);
    assert.equal(proxy.children.size, 0);
});

test('SMTPProxy.connection() rejects sockets after shutdown starts', () => {
    let proxy = Object.create(SMTPProxy.prototype);
    // an EventEmitter: connection() guards the socket with an 'error' listener the instant it
    // is accepted (real sockets are EventEmitters), before the refusal below
    let socket = new EventEmitter();
    let response;
    proxy.closing = true;
    proxy.children = new Set([makeChild()]);
    proxy.socketEnd = (receivedSocket, message) => {
        assert.strictEqual(receivedSocket, socket);
        response = message;
    };

    proxy.connection(socket);

    assert.equal(response, '421 Server shutting down');
    assert.deepEqual([...proxy.children][0].sent, []);
});

function makeSender() {
    let sender = Object.create(Sender.prototype);
    EventEmitter.call(sender);
    sender.closing = false;
    sender.closed = false;
    sender.activeSendOperations = 0;
    sender.zone = { name: 'good' };
    sender.logName = 'Sender/good/test';
    return sender;
}

test('Sender.close() immediately closes an idle sender', () => {
    let sender = makeSender();
    let closedCount = 0;
    sender.on('closed', () => closedCount++);

    sender.close();
    assert.equal(sender.closing, true);
    assert.equal(closedCount, 1);
});

test('Sender.close() waits for every active send operation', () => {
    let sender = makeSender();
    let closedCount = 0;
    sender.activeSendOperations = 2;
    sender.on('closed', () => closedCount++);

    sender.close();
    assert.equal(closedCount, 0);

    sender.activeSendOperations--;
    sender._checkClosed();
    assert.equal(closedCount, 0);

    sender.activeSendOperations--;
    sender._checkClosed();
    assert.equal(closedCount, 1);
});

test('Sender.sendNext() while draining does not fetch more work', () => {
    let sender = makeSender();
    sender.closing = true;
    let sendCommandCalled = false;
    sender.sendCommand = () => {
        sendCommandCalled = true;
    };
    sender.on('closed', () => {});

    sender.sendNext();

    assert.equal(sendCommandCalled, false);
});

test('Sender.close() is idempotent', () => {
    let sender = makeSender();
    let closedCount = 0;
    sender.on('closed', () => closedCount++);
    sender.close();
    assert.doesNotThrow(() => sender.close());
    assert.equal(sender.closing, true);
    assert.equal(closedCount, 1);
});

test('Sender.sendBounceMessage() waits for the queue acknowledgement', () => {
    let sender = makeSender();
    let commandCallback;
    sender.sendCommand = (command, callback) => {
        assert.equal(command.cmd, 'BOUNCE');
        commandCallback = callback;
    };

    let delivery = {
        id: 'message-id',
        sessionId: 'session-id',
        seq: '001',
        from: 'sender@example.com',
        recipient: 'recipient@example.com',
        headers: new Headers([]),
        account: {}
    };
    let callbackCalled = false;
    sender.sendBounceMessage(delivery, { category: 'recipient' }, '550 rejected', () => {
        callbackCalled = true;
    });

    assert.equal(callbackCalled, false);
    assert.equal(typeof commandCallback, 'function');
    commandCallback(null, true);
    assert.equal(callbackCalled, true);
});
