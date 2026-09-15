'use strict';

// RemoteQueue is the queue a forked SMTP child stores through, so these cover the store path
// every submission arriving over the wire takes: the upload marker around the window where
// chunks exist and the files document does not, and which stream errors count as a storage
// failure worth reporting.

const config = require('@zone-eu/wild-config');
config.dbs = config.dbs || {};
config.queue = config.queue || {};
config.queue.gfs = 'mail';

const { Writable, PassThrough } = require('stream');
const log = require('npmlog');

const RemoteQueue = require('../lib/remote-queue');
const gridfsPending = require('../lib/gridfs-pending');

const GFS = 'mail';

// Enough of a Mongo collection to drive the marker paths, over plain arrays. Writes go into the
// caller's call log, shared with the upload stream so the two can be ordered against each other.
function fakeDb(state, calls) {
    let collection = name => {
        let key = name.slice(GFS.length + 1);
        return {
            // The driver takes the options argument or leaves it out, and the marker code uses
            // both forms: creating upserts, a heartbeat deliberately does not.
            updateOne(query, update, opts, cb) {
                if (typeof opts === 'function') {
                    cb = opts;
                    opts = {};
                }
                calls.push({ op: 'updateOne', name });
                let found = state[key].find(doc => String(doc._id) === String(query._id));
                if (found) {
                    Object.assign(found, update.$set);
                } else if (opts && opts.upsert) {
                    state[key].push(Object.assign({ _id: query._id }, update.$set));
                }
                let result = { matchedCount: found ? 1 : 0, upsertedCount: !found && opts && opts.upsert ? 1 : 0 };
                return setImmediate(() => cb(null, result));
            },
            deleteOne(query, cb) {
                calls.push({ op: 'deleteOne', name });
                let index = state[key].findIndex(doc => String(doc._id) === String(query._id));
                if (index >= 0) {
                    state[key].splice(index, 1);
                }
                return setImmediate(() => cb(null, { deletedCount: index >= 0 ? 1 : 0 }));
            }
        };
    };

    return { collection };
}

function fakeUpload(calls, options) {
    options = options || {};
    let store = new Writable({
        write(chunk, encoding, cb) {
            calls.push({ op: 'write', name: 'upload' });
            cb(options.writeError || null);
        }
    });
    store.id = options.id || 'files-1';
    let destroy = store.destroy.bind(store);
    store.destroy = (...args) => {
        calls.push({ op: 'destroy', name: 'upload' });
        return destroy(...args);
    };
    return store;
}

function makeQueue(state, upload, calls) {
    calls = calls || [];
    let queue = new RemoteQueue();
    queue.mongodb = fakeDb(state, calls);
    queue.gridstore = { openUploadStream: () => upload };
    // The child does not delete GridFS itself; REMOVE goes to the master over IPC.
    queue.removed = [];
    queue.sendCommand = (command, cb) => {
        queue.removed.push(command);
        return setImmediate(() => cb(null, true));
    };
    return { queue, calls };
}

// npmlog is looked up per call, so replacing a level records what the store path reported.
// emitGelf sits inside the same branch as log.error and needs no separate watch.
function captureLog() {
    let entries = [];
    let original = { error: log.error, info: log.info, verbose: log.verbose };
    ['error', 'info', 'verbose'].forEach(level => {
        log[level] = (...args) => entries.push({ level, args });
    });
    return {
        entries,
        restore: () => Object.assign(log, original)
    };
}

module.exports['upload marks before the first chunk and hands the upload id back'] = test => {
    let state = { pending: [] };
    let calls = [];
    let upload = fakeUpload(calls);
    let { queue } = makeQueue(state, upload, calls);

    let source = new PassThrough();
    source.end('a message body');

    queue.store('msg-1', source, (err, id, filesId) => {
        test.ifError(err);
        test.equal(id, 'msg-1');

        let order = calls.map(entry => `${entry.op} ${entry.name}`);

        // The marker has to exist before anything is written, because a chunk that lands
        // without one is exactly the state nothing can find afterwards.
        test.equal(order.indexOf('updateOne mail.pending'), 0);
        test.ok(order.indexOf('write upload') > 0);

        // And it stays until the message is queued, which only the caller can tell it.
        test.equal(order.indexOf('deleteOne mail.pending'), -1);
        test.deepEqual(state.pending.map(row => row._id), ['files-1']);
        test.equal(filesId, 'files-1');
        test.done();
    });
};

module.exports['upload records the marker as writing, against the upload id'] = test => {
    let state = { pending: [] };
    let seen = [];

    // Sampled from inside the write, which is the only moment the answer matters: this is what a
    // reader would have found had the process died on the first chunk.
    let upload = new Writable({
        write(chunk, encoding, cb) {
            seen.push(state.pending.map(row => [row._id, row.state]));
            cb();
        }
    });
    upload.id = 'files-42';
    let { queue } = makeQueue(state, upload);

    let source = new PassThrough();
    source.end('body');

    queue.store('msg-2', source, () => {
        // The marker names the upload, not the message: files_id is the only thing the stranded
        // chunks carry.
        test.deepEqual(seen[0], [['files-42', 'writing']]);
        test.done();
    });
};

module.exports['upload fails and releases the handle when the marker cannot be written'] = test => {
    let state = { pending: [] };
    let calls = [];
    let upload = fakeUpload(calls);
    let { queue } = makeQueue(state, upload, calls);
    queue.mongodb = {
        collection: () => ({
            updateOne: (query, update, opts, cb) => setImmediate(() => cb(new Error('mongo down')))
        })
    };

    let source = new PassThrough();
    source.end('body');

    queue.store('msg-3', source, err => {
        test.equal(err.message, 'mongo down');

        // Nothing may be written without a marker, and the handle nobody will end now is
        // released rather than left open.
        let order = calls.map(entry => `${entry.op} ${entry.name}`);
        test.equal(order.indexOf('write upload'), -1);
        test.ok(order.indexOf('destroy upload') >= 0);
        test.done();
    });
};

module.exports['a failed upload keeps its marker for the collector to find'] = test => {
    // Chunks may already be written and no files document will ever name them, so clearing the
    // marker here would hide exactly what the collector is looking for.
    let state = { pending: [] };
    let upload = fakeUpload([], { writeError: new Error('disk full') });
    let { queue } = makeQueue(state, upload);

    let source = new PassThrough();
    source.end('body');

    queue.store('msg-err', source, err => {
        test.equal(err.message, 'disk full');
        test.deepEqual(state.pending.map(row => row._id), ['files-1']);
        test.done();
    });
};

module.exports['a client that hangs up is an outcome, not a storage failure'] = test => {
    let state = { pending: [] };
    let upload = fakeUpload([]);
    let { queue } = makeQueue(state, upload);
    let logged = captureLog();

    let source = new PassThrough();
    queue.store('msg-4', source, err => {
        logged.restore();
        test.equal(err.name, 'ClientDisconnect');

        // No error level, and so no failure code either: on a busy receiver this is routine, and
        // that is the channel real storage faults are alerted on.
        test.equal(logged.entries.filter(entry => entry.level === 'error').length, 0);
        test.ok(logged.entries.some(entry => entry.args.indexOf('%s ABORTED %s') >= 0));

        // The message is still handed to the master to remove, marker and chunks with it.
        test.deepEqual(queue.removed, [{ cmd: 'REMOVE', id: 'msg-4' }]);
        test.done();
    });

    source.write('partial body');
    let abort = new Error('Client disconnected before the message was complete');
    abort.name = 'ClientDisconnect';
    source.emit('error', abort);
};

module.exports['a real stream failure still reports itself'] = test => {
    let state = { pending: [] };
    let upload = fakeUpload([]);
    let { queue } = makeQueue(state, upload);
    let logged = captureLog();

    let source = new PassThrough();
    queue.store('msg-5', source, err => {
        logged.restore();
        test.equal(err.message, 'socket hang up');
        test.ok(logged.entries.some(entry => entry.level === 'error' && entry.args.indexOf('%s STREAMERR %s') >= 0));
        test.done();
    });

    source.write('partial body');
    source.emit('error', new Error('socket hang up'));
};

// The heartbeat runs on an interval, so the interval is what the test drives: replacing
// setInterval keeps it instant and needs no timer library.
function captureTimers() {
    let handles = [];
    let originals = { setInterval: global.setInterval, clearInterval: global.clearInterval };

    global.setInterval = fn => {
        let handle = { fn, cleared: false, unref: () => handle };
        handles.push(handle);
        return handle;
    };
    global.clearInterval = handle => {
        if (handle) {
            handle.cleared = true;
        }
    };

    return {
        tick: () => handles.filter(handle => !handle.cleared).forEach(handle => handle.fn()),
        restore: () => Object.assign(global, originals)
    };
}

module.exports['a source that dies while the marker is being written leaves no heartbeat behind'] = test => {
    // The two race: the error handler stops a heartbeat that the marker write has not started yet,
    // and the write then starts one with nobody left to claim it. A timer nobody owns goes on
    // renewing a marker for an upload that ended, which is the one state the collector cannot see
    // past.
    let state = { pending: [] };
    let calls = [];
    let upload = fakeUpload(calls);
    let { queue } = makeQueue(state, upload, calls);
    let timers = captureTimers();

    let source = new PassThrough();
    let real = queue.mongodb.collection;
    queue.mongodb.collection = name => {
        let collection = real(name);
        return Object.assign({}, collection, {
            updateOne(query, update, opts, cb) {
                // The client goes away while Mongo is still acknowledging the marker.
                source.emit('error', Object.assign(new Error('gone'), { name: 'ClientDisconnect' }));
                return collection.updateOne(query, update, opts, cb);
            }
        });
    };

    source.write('partial body');

    queue.store('msg-race', source, () => {
        setImmediate(() => {
            let written = calls.filter(entry => entry.op === 'updateOne').length;

            timers.tick();
            timers.tick();
            timers.restore();

            setImmediate(() => {
                test.equal(calls.filter(entry => entry.op === 'updateOne').length, written);
                test.equal(gridfsPending.HEARTBEAT_INTERVAL > 0, true);
                test.done();
            });
        });
    });
};
