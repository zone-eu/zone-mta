'use strict';

// GridFS uploads and deletes are two non-atomic sequences, and an interruption in either used to
// leave chunks that nothing names: files_id is their only link and it is recorded nowhere else.
// A marker document written before each sequence and removed after it is what makes the state
// recoverable, and what lets the collector tell an unfinished upload from a finished one.

const config = require('@zone-eu/wild-config');
config.dbs = config.dbs || {};

const { Writable, PassThrough } = require('stream');

const MailQueue = require('../lib/mail-queue');
const gridfsPending = require('../lib/gridfs-pending');

const GFS = 'mail';
const MINUTE = 60 * 1000;

// Enough of a Mongo collection to drive the paths under test, over plain arrays.
function fakeDb(state) {
    let calls = [];

    let match = (doc, query) => {
        for (let key of Object.keys(query)) {
            let want = query[key];
            if (want && typeof want === 'object' && !(want instanceof Date) && '$lte' in want) {
                if (!(doc[key] <= want.$lte)) {
                    return false;
                }
            } else if (String(doc[key]) !== String(want)) {
                return false;
            }
        }
        return true;
    };

    let collection = name => {
        if (typeof name !== 'string' || name.indexOf(GFS + '.') !== 0) {
            // The queue collection: the lock release before the disableGC guard, and the
            // collector asking whether a stored message has a delivery behind it.
            return {
                updateMany: async () => ({ modifiedCount: 0 }),
                findOne: async query => (state.queue || []).find(doc => match(doc, query)) || null
            };
        }

        let key = name.slice(GFS.length + 1);
        let rows = () => state[key];

        return {
            find(query) {
                let found = rows().filter(doc => match(doc, query));
                let i = 0;
                return {
                    hasNext: async () => i < found.length,
                    next: async () => found[i++],
                    close: async () => true
                };
            },
            findOne(query, opts, cb) {
                let found = rows().find(doc => match(doc, query)) || null;
                if (typeof opts === 'function') {
                    return setImmediate(() => opts(null, found));
                }
                if (typeof cb === 'function') {
                    return setImmediate(() => cb(null, found));
                }
                return Promise.resolve(found);
            },
            deleteMany(query, cb) {
                calls.push({ op: 'deleteMany', name, query });
                let kept = rows().filter(doc => !match(doc, query));
                let removed = rows().length - kept.length;
                state[key] = kept;
                if (typeof cb === 'function') {
                    return setImmediate(() => cb(null, { deletedCount: removed }));
                }
                return Promise.resolve({ deletedCount: removed });
            },
            deleteOne(query, cb) {
                calls.push({ op: 'deleteOne', name, query });
                let index = rows().findIndex(doc => match(doc, query));
                if (index >= 0) {
                    rows().splice(index, 1);
                }
                if (typeof cb === 'function') {
                    return setImmediate(() => cb(null, { deletedCount: index >= 0 ? 1 : 0 }));
                }
                return Promise.resolve({ deletedCount: index >= 0 ? 1 : 0 });
            },
            // The driver takes the options argument or leaves it out, and the marker code uses
            // both forms: creating upserts, a heartbeat deliberately does not.
            updateOne(query, update, opts, cb) {
                if (typeof opts === 'function') {
                    cb = opts;
                    opts = {};
                }
                calls.push({ op: 'updateOne', name, query, update });
                let found = rows().find(doc => match(doc, query));
                if (found) {
                    Object.assign(found, update.$set);
                } else if (opts && opts.upsert) {
                    rows().push(Object.assign({ _id: query._id }, update.$set));
                }
                let result = { matchedCount: found ? 1 : 0, upsertedCount: !found && opts && opts.upsert ? 1 : 0 };
                if (typeof cb === 'function') {
                    return setImmediate(() => cb(null, result));
                }
                return Promise.resolve(result);
            }
        };
    };

    return { db: { collection }, calls };
}

function makeQueue(state, options) {
    let queue = new MailQueue(Object.assign({ gfs: GFS }, options));
    let { db, calls } = fakeDb(state);
    queue.mongodb = db;
    return { queue, calls };
}

// A marker carries the moment it stops being anybody's, so these are deadlines, not birthdays.
let dead = () => new Date(Date.now() - 60 * MINUTE);
let beating = () => new Date(Date.now() + 3 * MINUTE);

module.exports['collector removes the chunks of an upload that never produced a files document'] = test => {
    let state = {
        files: [],
        chunks: [{ files_id: 'a', n: 0 }, { files_id: 'a', n: 1 }, { files_id: 'b', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue
        .collectPendingGridfs()
        .then(() => {
            test.deepEqual(state.chunks, [{ files_id: 'b', n: 0 }]);
            test.equal(state.pending.length, 0);
            test.done();
        })
        .catch(err => {
            test.ifError(err);
            test.done();
        });
};

module.exports['collector keeps a message that reached the queue and only lost its marker'] = test => {
    // Deleting on sight here would destroy a message that was queued successfully, so the
    // delivery is what says the file belongs to something.
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }],
        queue: [{ id: '1' }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        test.equal(state.files.length, 1);
        test.equal(state.chunks.length, 1);
        test.equal(state.pending.length, 0);
        test.done();
    });
};

module.exports['collector removes a message that was stored but never queued'] = test => {
    // The upload finished, so the chunks are reachable and nothing here looks broken - but no
    // delivery references the file, and the marker outlives the upload precisely so this case is
    // visible. A process that dies between storing and queueing leaves exactly this.
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }],
        queue: []
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        test.equal(state.files.length, 0);
        test.equal(state.chunks.length, 0);
        test.equal(state.pending.length, 0);
        test.done();
    });
};

module.exports['collector leaves a file it cannot name alone'] = test => {
    // A filename the collector cannot map back to a message id is not evidence of anything, and
    // guessing costs a message.
    let state = {
        files: [{ _id: 'a', filename: 'something else' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }],
        queue: []
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        test.equal(state.files.length, 1);
        test.equal(state.chunks.length, 1);
        test.equal(state.pending.length, 0);
        test.done();
    });
};

module.exports['collector finishes a delete that stopped partway'] = test => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'deleting', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        test.equal(state.files.length, 0);
        test.equal(state.chunks.length, 0);
        test.equal(state.pending.length, 0);
        test.done();
    });
};

module.exports['collector drops the marker of a delete that all but finished'] = test => {
    let state = {
        files: [],
        chunks: [{ files_id: 'b', n: 0 }],
        pending: [{ _id: 'a', state: 'deleting', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        test.equal(state.pending.length, 0);
        test.equal(state.chunks.length, 1);
        test.done();
    });
};

module.exports['collector leaves an upload that is still arriving alone'] = test => {
    let state = {
        files: [],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: beating() }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        test.equal(state.pending.length, 1);
        test.equal(state.chunks.length, 1);
        test.done();
    });
};

// The deadline on a marker is pushed forward by a heartbeat in the very process doing the
// writing, so it cannot outlive it: a child killed, out of memory, or thrown out of its event
// loop takes its timers with it and the marker goes stale with no cleanup path having to run.
//
// The heartbeat runs on an interval, so the interval is what the tests drive: replacing
// setInterval keeps them instant and needs no timer library.
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

module.exports['a marker is born already carrying the moment it stops being anybody\'s'] = test => {
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        timers.restore();
        let marker = state.pending[0];
        let ahead = marker.expires.getTime() - Date.now();

        test.equal(marker.state, 'writing');
        test.ok(ahead > gridfsPending.MARKER_TTL - gridfsPending.HEARTBEAT_INTERVAL);
        test.ok(ahead <= gridfsPending.MARKER_TTL);
        gridfsPending.stopPending('files-1');
        test.done();
    });
};

module.exports['each beat moves the deadline, whether or not any bytes were written'] = test => {
    // Which is the point: headers are parsed before the body reaches the upload stream, and the
    // scan and the queue push come after it. None of that writes a chunk, and all of it belongs
    // to an operation that is still alive.
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        let first = state.pending[0].expires.getTime();
        timers.tick();
        timers.restore();

        setImmediate(() => {
            test.ok(state.pending[0].expires.getTime() >= first);
            gridfsPending.stopPending('files-1');
            test.done();
        });
    });
};

module.exports['a beat never raises a marker somebody else took away'] = test => {
    // The operation an id belongs to can be ended by a different process than the one beating for
    // it: an SMTP child hands its cleanup to the master over IPC. A beat that could create would
    // bring the marker back there and then beat for it forever.
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        state.pending.length = 0;
        timers.tick();
        timers.tick();
        timers.restore();

        setImmediate(() => {
            test.equal(state.pending.length, 0);
            gridfsPending.stopPending('files-1');
            test.done();
        });
    });
};

module.exports['stopping leaves the marker behind to go stale, which is what the collector is for'] = test => {
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        let frozen = state.pending[0].expires.getTime();
        gridfsPending.stopPending('files-1');
        timers.tick();
        timers.restore();

        setImmediate(() => {
            // Still there, and no longer moving: the chunks it wrote are exactly what the
            // collector is looking for, so taking the marker back would hide them.
            test.equal(state.pending[0].expires.getTime(), frozen);
            test.done();
        });
    });
};

module.exports['clearing takes the marker away and the heartbeat with it'] = test => {
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        gridfsPending.clearPending(db, GFS, 'files-1', () => {
            timers.tick();
            timers.restore();

            setImmediate(() => {
                test.equal(state.pending.length, 0);
                test.done();
            });
        });
    });
};

module.exports['delete removes the chunks before the files document'] = test => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: []
    };
    let { queue, calls } = makeQueue(state);

    queue.removeGridfsFile('a', err => {
        test.ifError(err);

        let order = calls.map(entry => `${entry.op} ${entry.name}`);
        test.deepEqual(order, ['updateOne mail.pending', 'deleteMany mail.chunks', 'deleteOne mail.files', 'deleteOne mail.pending']);

        test.equal(state.files.length, 0);
        test.equal(state.chunks.length, 0);
        test.equal(state.pending.length, 0);
        test.done();
    });
};

module.exports['delete takes over an upload marker instead of colliding with it'] = test => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue.removeGridfsFile('a', err => {
        test.ifError(err);
        test.equal(state.pending.length, 0);
        test.done();
    });
};

module.exports['collection runs even when the age-based GC is disabled'] = test => {
    // disableGC means "do not remove old data". An interrupted operation is not old data, and
    // leaving it gated would let the marker collection grow with nothing to drain it.
    let state = {
        files: [],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }]
    };
    let { queue } = makeQueue(state, { disableGC: true, collection: 'zone-queue' });

    queue
        .clearGarbage()
        .then(() => {
            test.equal(state.chunks.length, 0);
            test.equal(state.pending.length, 0);
            test.done();
        })
        .catch(err => {
            test.ifError(err);
            test.done();
        });
};

// A GridFS upload stream stands in for the real one: it carries the id openUploadStream assigns
// in its constructor, and records every chunk that reaches it so the marker can be placed
// against the writes in time.
function fakeUpload(calls, id) {
    let store = new Writable({
        write(chunk, encoding, cb) {
            calls.push({ op: 'write', name: 'upload' });
            cb();
        }
    });
    store.id = id || 'files-1';
    let destroy = store.destroy.bind(store);
    store.destroy = (...args) => {
        calls.push({ op: 'destroy', name: 'upload' });
        return destroy(...args);
    };
    return store;
}

module.exports['upload marks before the first chunk and hands the upload id back'] = test => {
    let state = { files: [], chunks: [], pending: [] };
    let { queue, calls } = makeQueue(state);
    queue.gridstore = { openUploadStream: () => fakeUpload(calls) };

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

        // And it stays: a stored message that never reaches the queue belongs to nobody, and only
        // the caller knows when it does. The upload id comes back so it can say so.
        test.equal(order.indexOf('deleteOne mail.pending'), -1);
        test.deepEqual(state.pending.map(row => row._id), ['files-1']);
        test.equal(filesId, 'files-1');
        test.done();
    });
};

module.exports['upload fails and releases the handle when the marker cannot be written'] = test => {
    let state = { files: [], chunks: [], pending: [] };
    let { queue, calls } = makeQueue(state);
    queue.gridstore = { openUploadStream: () => fakeUpload(calls) };
    queue.markPending = (filesId, markerState, cb) => setImmediate(() => cb(new Error('mongo down')));

    let source = new PassThrough();
    source.end('body');

    queue.store('msg-2', source, err => {
        test.ok(err);
        test.equal(err.message, 'mongo down');

        // Nothing may be written without a marker, and the handle nobody will end now is
        // released rather than left open.
        let order = calls.map(entry => `${entry.op} ${entry.name}`);
        test.equal(order.indexOf('write upload'), -1);
        test.ok(order.indexOf('destroy upload') >= 0);
        test.done();
    });
};

module.exports['one failing marker does not cost the rest of the pass'] = test => {
    // A transient Mongo error used to abort the whole loop, and checkGarbage backs off to five
    // minutes after a throw, so everything behind the failure waited with it.
    let state = {
        files: [],
        chunks: [
            { files_id: 'bad', n: 0 },
            { files_id: 'good', n: 0 }
        ],
        pending: [
            { _id: 'bad', state: 'writing', expires: dead() },
            { _id: 'good', state: 'writing', expires: dead() }
        ]
    };
    let { queue } = makeQueue(state);

    let inner = queue.mongodb.collection;
    let chunks = inner('mail.chunks');
    queue.mongodb.collection = name =>
        name !== 'mail.chunks'
            ? inner(name)
            : Object.assign({}, chunks, {
                  deleteMany: query => (String(query.files_id) === 'bad' ? Promise.reject(new Error('mongo timeout')) : chunks.deleteMany(query))
              });

    queue.collectPendingGridfs().then(() => {
        // The failing one keeps its marker, so the next pass tries again rather than losing it.
        test.deepEqual(state.pending.map(row => row._id), ['bad']);
        test.deepEqual(state.chunks.map(row => row.files_id), ['bad']);
        test.done();
    });
};

module.exports['a failed upload keeps its marker, and the GC clears what it left behind'] = test => {
    // The upload stream erroring is not the same as the source ending early: chunks may already
    // be written and no files document will ever name them, so the marker has to survive for the
    // collector to act on.
    let state = { files: [], chunks: [{ files_id: 'files-err', n: 0 }], pending: [] };
    let { queue } = makeQueue(state);

    let upload = new Writable({
        write(chunk, encoding, cb) {
            cb(new Error('disk full'));
        }
    });
    upload.id = 'files-err';
    queue.gridstore = { openUploadStream: () => upload };

    let source = new PassThrough();
    source.end('body');

    queue.store('msg-err', source, err => {
        test.ok(err);
        test.equal(err.message, 'disk full');

        // Still there, deliberately: clearing it would hide the chunks from the collector.
        test.deepEqual(state.pending.map(row => row._id), ['files-err']);

        // Its deadline is still ahead, so the next pass leaves it alone: an upload that just
        // failed is indistinguishable from one still arriving until the beats stop.
        queue
            .collectPendingGridfs()
            .then(() => {
                test.equal(state.pending.length, 1);
                // Nothing is beating for it any more, so the deadline arrives.
                state.pending[0].expires = dead();
                return queue.collectPendingGridfs();
            })
            .then(() => {
                test.equal(state.chunks.length, 0);
                test.equal(state.pending.length, 0);
                test.done();
            });
    });
};
