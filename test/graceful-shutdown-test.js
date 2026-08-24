'use strict';

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

module.exports['SendingZone.close() sends shutdown to every sender child'] = test => {
    let zone = Object.create(SendingZone.prototype);
    let c1 = makeChild();
    let c2 = makeChild();
    zone.children = new Set([c1, c2]);

    zone.close();

    test.deepEqual(c1.sent, [{ shutdown: true }]);
    test.deepEqual(c2.sent, [{ shutdown: true }]);
    test.done();
};

module.exports['SendingZone.close() survives a dead IPC channel and still notifies the rest'] = test => {
    // send() can fail synchronously or through its callback, neither may abort the loop.
    // Insertion order is iteration order: the dead child goes first, so if the failure were
    // not handled the alive child would never be notified.
    [makeChild(true), makeChild(false, true)].forEach(dead => {
        let zone = Object.create(SendingZone.prototype);
        let alive = makeChild();
        zone.children = new Set([dead, alive]);

        test.doesNotThrow(() => zone.close());
        test.deepEqual(alive.sent, [{ shutdown: true }]);
    });
    test.done();
};

module.exports['closeSenders() calls close() on every registered zone'] = test => {
    let goodClosed = 0;
    let badClosed = 0;
    sendingZoneModule.sendingZonelist.set('good', { close: () => goodClosed++ });
    sendingZoneModule.sendingZonelist.set('bad', { close: () => badClosed++ });

    try {
        sendingZoneModule.closeSenders();

        test.equal(goodClosed, 1);
        test.equal(badClosed, 1);
    } finally {
        // shared module level state, a failing assertion must not leave the fakes behind
        sendingZoneModule.sendingZonelist.delete('good');
        sendingZoneModule.sendingZonelist.delete('bad');
    }
    test.done();
};

module.exports['SMTPProxy.closeChildren() sets closing and notifies every receiver child'] = test => {
    let proxy = Object.create(SMTPProxy.prototype);
    proxy.closing = false;
    let c1 = makeChild();
    let c2 = makeChild();
    proxy.children = new Set([c1, c2]);

    proxy.closeChildren();

    // `closing` must be set so the 'close' handler treats the exit as expected (no error log,
    // no respawn).
    test.equal(proxy.closing, true);
    test.deepEqual(c1.sent, [{ shutdown: true }]);
    test.deepEqual(c2.sent, [{ shutdown: true }]);
    test.done();
};

module.exports['SMTPInterface.close() waits for proxy-worker SMTP sessions'] = test => {
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
        test.equal(nativeCloseCalled, false);
        test.done();
    });

    // `closing` must be set right away so that the sessions that are still open start
    // rejecting new mail transactions while the rest of them finishes up.
    test.equal(smtpInterface.closing, true);
    test.equal(callbackCalled, false);
    setTimeout(() => connections.delete(connection), 10);
};

module.exports['SendingZone.spawnSender() does not fork after shutdown starts'] = test => {
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
            test.equal(forkCalled, false);
            test.equal(zone.children.size, 0);
            test.done();
        });
    } finally {
        childProcess.fork = originalFork;
    }
};

module.exports['SMTPProxy.spawnReceiver() does not fork after shutdown starts'] = test => {
    let proxy = Object.create(SMTPProxy.prototype);
    proxy.closing = true;
    proxy.children = new Set();
    proxy.processes = 1;
    let originalFork = childProcess.fork;
    let forkCalled = false;
    childProcess.fork = () => {
        forkCalled = true;
    };

    test.equal(proxy.spawnReceiver(), false);
    childProcess.fork = originalFork;
    test.equal(forkCalled, false);
    test.equal(proxy.children.size, 0);
    test.done();
};

module.exports['SMTPProxy.connection() rejects sockets after shutdown starts'] = test => {
    let proxy = Object.create(SMTPProxy.prototype);
    let socket = {};
    let response;
    proxy.closing = true;
    proxy.children = new Set([makeChild()]);
    proxy.socketEnd = (receivedSocket, message) => {
        test.strictEqual(receivedSocket, socket);
        response = message;
    };

    proxy.connection(socket);

    test.equal(response, '421 Server shutting down');
    test.deepEqual([...proxy.children][0].sent, []);
    test.done();
};

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

module.exports['Sender.close() immediately closes an idle sender'] = test => {
    let sender = makeSender();
    let closedCount = 0;
    sender.on('closed', () => closedCount++);

    sender.close();
    test.equal(sender.closing, true);
    test.equal(closedCount, 1);
    test.done();
};

module.exports['Sender.close() waits for every active send operation'] = test => {
    let sender = makeSender();
    let closedCount = 0;
    sender.activeSendOperations = 2;
    sender.on('closed', () => closedCount++);

    sender.close();
    test.equal(closedCount, 0);

    sender.activeSendOperations--;
    sender._checkClosed();
    test.equal(closedCount, 0);

    sender.activeSendOperations--;
    sender._checkClosed();
    test.equal(closedCount, 1);
    test.done();
};

module.exports['Sender.sendNext() while draining does not fetch more work'] = test => {
    let sender = makeSender();
    sender.closing = true;
    let sendCommandCalled = false;
    sender.sendCommand = () => {
        sendCommandCalled = true;
    };
    sender.on('closed', () => {});

    sender.sendNext();

    test.equal(sendCommandCalled, false);
    test.done();
};

module.exports['Sender.close() is idempotent'] = test => {
    let sender = makeSender();
    let closedCount = 0;
    sender.on('closed', () => closedCount++);
    sender.close();
    test.doesNotThrow(() => sender.close());
    test.equal(sender.closing, true);
    test.equal(closedCount, 1);
    test.done();
};

module.exports['Sender.sendBounceMessage() waits for the queue acknowledgement'] = test => {
    let sender = makeSender();
    let commandCallback;
    sender.sendCommand = (command, callback) => {
        test.equal(command.cmd, 'BOUNCE');
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

    test.equal(callbackCalled, false);
    test.equal(typeof commandCallback, 'function');
    commandCallback(null, true);
    test.equal(callbackCalled, true);
    test.done();
};
