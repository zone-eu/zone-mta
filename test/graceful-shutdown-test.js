'use strict';

// Covers the notify + drain primitives the graceful-shutdown wiring relies on:
//   - SendingZone.close() / closeSenders()  -> IPC { shutdown: true } to sender children
//   - SMTPProxy.closeChildren()             -> IPC { shutdown: true } to receiver children
//   - Sender.close() + sendNext()           -> the 'closed' drain handshake
// The actual process.on('message', ...) handlers in services/sender.js and
// services/receiver.js run as forked child processes and can't be required in-process,
// so this only exercises the building blocks they call.

const EventEmitter = require('events');
const sendingZoneModule = require('../lib/sending-zone');
const { SendingZone } = sendingZoneModule;
const SMTPProxy = require('../lib/receiver/smtp-proxy');
const Sender = require('../lib/sender');

// A fake forked child: records what was sent over the IPC channel. throwOnSend simulates
// a channel that is already gone (child exited), so we can assert the notify loop keeps
// going instead of stopping at the first dead child.
function makeChild(throwOnSend) {
    let sent = [];
    return {
        sent,
        send(msg) {
            if (throwOnSend) {
                throw new Error('channel closed');
            }
            sent.push(msg);
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

module.exports['SendingZone.close() swallows a dead IPC channel and still notifies the rest'] = test => {
    let zone = Object.create(SendingZone.prototype);
    let dead = makeChild(true);
    let alive = makeChild();
    // Insertion order is iteration order: the dead child goes first, so if the throw were
    // not caught the alive child would never be notified.
    zone.children = new Set([dead, alive]);

    test.doesNotThrow(() => zone.close());
    test.deepEqual(alive.sent, [{ shutdown: true }]);
    test.done();
};

module.exports['closeSenders() calls close() on every registered zone'] = test => {
    let goodClosed = 0;
    let badClosed = 0;
    sendingZoneModule.sendingZonelist.set('good', { close: () => goodClosed++ });
    sendingZoneModule.sendingZonelist.set('bad', { close: () => badClosed++ });

    sendingZoneModule.closeSenders();

    test.equal(goodClosed, 1);
    test.equal(badClosed, 1);
    sendingZoneModule.sendingZonelist.clear();
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

module.exports['SMTPProxy.closeChildren() swallows a dead IPC channel and still notifies the rest'] = test => {
    let proxy = Object.create(SMTPProxy.prototype);
    proxy.closing = false;
    let dead = makeChild(true);
    let alive = makeChild();
    proxy.children = new Set([dead, alive]);

    test.doesNotThrow(() => proxy.closeChildren());
    test.deepEqual(alive.sent, [{ shutdown: true }]);
    test.done();
};

function makeSender() {
    let sender = Object.create(Sender.prototype);
    EventEmitter.call(sender);
    sender.closing = false;
    sender.zone = { name: 'good' };
    sender.logName = 'Sender/good/test';
    return sender;
}

module.exports['Sender.close() flips closing and the next sendNext() emits "closed"'] = test => {
    let sender = makeSender();
    let closedCount = 0;
    sender.on('closed', () => closedCount++);

    sender.close();
    test.equal(sender.closing, true);

    // The next loop cycle hits the drain gate and signals it has stopped, letting
    // services/sender.js know this sender is done.
    sender.sendNext();
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
    sender.close();
    test.doesNotThrow(() => sender.close());
    test.equal(sender.closing, true);
    test.done();
};