'use strict';

const test = require('node:test');
const assert = require('node:assert');

// GridFS uploads and deletes are two non-atomic sequences, and an interruption in either used to
// leave chunks that nothing names: files_id is their only link and it is recorded nowhere else.
// A marker document written before each sequence and removed after it is what makes the state
// recoverable, and what lets the collector tell an unfinished upload from a finished one.

const config = require('@zone-eu/wild-config');
config.dbs = config.dbs || {};

const { Writable, PassThrough } = require('stream');
const { ObjectId } = require('mongodb');
const PluginHandler = require('@zone-eu/wild-plugins');

const MailQueue = require('../lib/mail-queue');
const plugins = require('../lib/plugins');
const gridfsPending = require('../lib/gridfs-pending');

const GFS = 'mail';
const MINUTE = 60 * 1000;

// Enough of a Mongo collection to drive the paths under test, over plain arrays.
function fakeDb(state) {
    let calls = [];

    let match = (doc, query) => {
        for (let key of Object.keys(query)) {
            let want = query[key];
            if (want && typeof want === 'object' && '$exists' in want) {
                if ((doc[key] !== undefined) !== want.$exists) {
                    return false;
                }
            } else if (want && typeof want === 'object' && !(want instanceof Date) && '$lte' in want) {
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
        let key = typeof name === 'string' && name.indexOf(GFS + '.') === 0 ? name.slice(GFS.length + 1) : 'queue';
        state[key] = state[key] || [];
        let rows = () => state[key];

        return {
            updateMany: async () => ({ modifiedCount: 0 }),
            find(query) {
                let found = rows().filter(doc => match(doc, query)).map(doc => Object.assign({}, doc));
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
                    for (let field of Object.keys(update.$unset || {})) {
                        delete found[field];
                    }
                } else if (opts && opts.upsert) {
                    if (rows().some(doc => String(doc._id) === String(query._id))) {
                        let err = Object.assign(new Error('duplicate key'), { code: 11000 });
                        return cb ? setImmediate(() => cb(err)) : Promise.reject(err);
                    }
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

test('collector removes the chunks of an upload that never produced a files document', (_t, finishTest) => {
    let state = {
        files: [],
        chunks: [{ files_id: 'a', n: 0 }, { files_id: 'a', n: 1 }, { files_id: 'b', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue
        .collectPendingGridfs()
        .then(() => {
            assert.deepEqual(state.chunks, [{ files_id: 'b', n: 0 }]);
            assert.equal(state.pending.length, 0);
            finishTest();
        })
        .catch(err => {
            assert.ifError(err);
            finishTest();
        });
});

test('collector keeps a queued message and its marker', (_t, finishTest) => {
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
        assert.equal(state.files.length, 1);
        assert.equal(state.chunks.length, 1);
        assert.equal(state.pending.length, 1);
        finishTest();
    });
});

test('collector removes a message that was stored but never queued', (_t, finishTest) => {
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
        assert.equal(state.files.length, 0);
        assert.equal(state.chunks.length, 0);
        assert.equal(state.pending.length, 0);
        finishTest();
    });
});

test('collector leaves a file it cannot name alone', (_t, finishTest) => {
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
        assert.equal(state.files.length, 1);
        assert.equal(state.chunks.length, 1);
        assert.equal(state.pending.length, 1);
        finishTest();
    });
});

test('collector finishes a delete that stopped partway', (_t, finishTest) => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'deleting', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        assert.equal(state.files.length, 0);
        assert.equal(state.chunks.length, 0);
        assert.equal(state.pending.length, 0);
        finishTest();
    });
});

test('collector drops the marker of a delete that all but finished', (_t, finishTest) => {
    let state = {
        files: [],
        chunks: [{ files_id: 'b', n: 0 }],
        pending: [{ _id: 'a', state: 'deleting', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        assert.equal(state.pending.length, 0);
        assert.equal(state.chunks.length, 1);
        finishTest();
    });
});

test('collector leaves an upload that is still arriving alone', (_t, finishTest) => {
    let state = {
        files: [],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: beating() }]
    };
    let { queue } = makeQueue(state);

    queue.collectPendingGridfs().then(() => {
        assert.equal(state.pending.length, 1);
        assert.equal(state.chunks.length, 1);
        finishTest();
    });
});

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

test('a marker is born already carrying the moment it stops being anybody\'s', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        timers.restore();
        let marker = state.pending[0];
        let ahead = marker.expires.getTime() - Date.now();

        assert.equal(marker.state, 'writing');
        assert.ok(ahead > gridfsPending.MARKER_TTL - gridfsPending.HEARTBEAT_INTERVAL);
        assert.ok(ahead <= gridfsPending.MARKER_TTL);
        gridfsPending.stopPending('files-1');
        finishTest();
    });
});

test('each beat moves the deadline, whether or not any bytes were written', (_t, finishTest) => {
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
            assert.ok(state.pending[0].expires.getTime() >= first);
            gridfsPending.stopPending('files-1');
            finishTest();
        });
    });
});

test('a delayed upload heartbeat cannot stop the heartbeat of a delete that took over', (_t, finishTest) => {
    let state = { pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();
    let collection = db.collection;
    let replies = [];
    let lost = 0;
    db.collection = name => {
        let result = collection(name);
        let updateOne = result.updateOne;
        result.updateOne = (query, update, opts, cb) => {
            if (typeof opts === 'function') {
                // The server's response to an old heartbeat can arrive after this process
                // has stopped it and started a different operation for the same files_id.
                replies.push(opts);
                return;
            }
            return updateOne(query, update, opts, cb);
        };
        return result;
    };

    gridfsPending.markPending(db, GFS, 'a', 'writing', err => {
        assert.ifError(err);
        timers.tick();
        gridfsPending.markPending(db, GFS, 'a', 'deleting', err => {
            assert.ifError(err);
            replies[0](null, { matchedCount: 0 });
            assert.equal(lost, 0);
            timers.tick();
            assert.equal(replies.length, 2, 'the new delete must still have a heartbeat');
            gridfsPending.stopPending('a');
            timers.restore();
            finishTest();
        });
    }, () => lost++);
});

test('a beat never raises a marker somebody else took away', (_t, finishTest) => {
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
            assert.equal(state.pending.length, 0);
            gridfsPending.stopPending('files-1');
            finishTest();
        });
    });
});

test('stopping leaves the marker behind to go stale, which is what the collector is for', (_t, finishTest) => {
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
            assert.equal(state.pending[0].expires.getTime(), frozen);
            finishTest();
        });
    });
});

test('clearing takes the marker away and the heartbeat with it', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();

    gridfsPending.markPending(db, GFS, 'files-1', 'writing', () => {
        gridfsPending.clearPending(db, GFS, 'files-1', () => {
            timers.tick();
            timers.restore();

            setImmediate(() => {
                assert.equal(state.pending.length, 0);
                finishTest();
            });
        });
    });
});

test('delete removes the chunks before the files document', (_t, finishTest) => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: []
    };
    let { queue, calls } = makeQueue(state);

    queue.removeGridfsFile('a', err => {
        assert.ifError(err);

        let order = calls.map(entry => `${entry.op} ${entry.name}`);
        assert.deepEqual(order, ['updateOne mail.pending', 'deleteMany mail.chunks', 'deleteOne mail.files', 'deleteOne mail.pending']);

        assert.equal(state.files.length, 0);
        assert.equal(state.chunks.length, 0);
        assert.equal(state.pending.length, 0);
        finishTest();
    });
});

test('delete takes over an upload marker instead of colliding with it', (_t, finishTest) => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a', n: 0 }],
        pending: [{ _id: 'a', state: 'writing', expires: dead() }]
    };
    let { queue } = makeQueue(state);

    queue.removeGridfsFile('a', err => {
        assert.ifError(err);
        assert.equal(state.pending.length, 0);
        finishTest();
    });
});

test('collection runs even when the age-based GC is disabled', (_t, finishTest) => {
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
            assert.equal(state.chunks.length, 0);
            assert.equal(state.pending.length, 0);
            finishTest();
        })
        .catch(err => {
            assert.ifError(err);
            finishTest();
        });
});

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

test('upload marks before the first chunk and hands the upload id back', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { queue, calls } = makeQueue(state);
    queue.gridstore = { openUploadStream: () => fakeUpload(calls) };

    let source = new PassThrough();
    source.end('a message body');

    queue.store('msg-1', source, (err, id, filesId) => {
        assert.ifError(err);
        assert.equal(id, 'msg-1');

        let order = calls.map(entry => `${entry.op} ${entry.name}`);

        // The marker has to exist before anything is written, because a chunk that lands
        // without one is exactly the state nothing can find afterwards.
        assert.equal(order.indexOf('updateOne mail.pending'), 0);
        assert.ok(order.indexOf('write upload') > 0);

        // And it stays: a stored message that never reaches the queue belongs to nobody, and only
        // the caller knows when it does. The upload id comes back so it can say so.
        assert.equal(order.indexOf('deleteOne mail.pending'), -1);
        assert.deepEqual(state.pending.map(row => row._id), ['files-1']);
        assert.equal(filesId, 'files-1');
        finishTest();
    });
});

test('upload fails and releases the handle when the marker cannot be written', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { queue, calls } = makeQueue(state);
    queue.gridstore = { openUploadStream: () => fakeUpload(calls) };
    queue.mongodb.collection = () => ({
        updateOne: (query, update, opts, cb) => setImmediate(() => cb(new Error('mongo down')))
    });

    let source = new PassThrough();
    source.end('body');

    queue.store('msg-2', source, err => {
        assert.ok(err);
        assert.equal(err.message, 'mongo down');

        // Nothing may be written without a marker, and the handle nobody will end now is
        // released rather than left open.
        let order = calls.map(entry => `${entry.op} ${entry.name}`);
        assert.equal(order.indexOf('write upload'), -1);
        assert.ok(order.indexOf('destroy upload') >= 0);
        finishTest();
    });
});

test('one failing marker does not cost the rest of the pass', (_t, finishTest) => {
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
        assert.deepEqual(state.pending.map(row => row._id), ['bad']);
        assert.deepEqual(state.chunks.map(row => row.files_id), ['bad']);
        finishTest();
    });
});

test('a failed upload keeps its marker, and the GC clears what it left behind', (_t, finishTest) => {
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
        assert.ok(err);
        assert.equal(err.message, 'disk full');

        // Still there, deliberately: clearing it would hide the chunks from the collector.
        assert.deepEqual(state.pending.map(row => row._id), ['files-err']);

        // Its deadline is still ahead, so the next pass leaves it alone: an upload that just
        // failed is indistinguishable from one still arriving until the beats stop.
        queue
            .collectPendingGridfs()
            .then(() => {
                assert.equal(state.pending.length, 1);
                // Nothing is beating for it any more, so the deadline arrives.
                state.pending[0].expires = dead();
                return queue.collectPendingGridfs();
            })
            .then(() => {
                assert.equal(state.chunks.length, 0);
                assert.equal(state.pending.length, 0);
                finishTest();
            });
    });
});

test('collector skips a marker renewed after the cursor read', (_t, finishTest) => {
    let state = { files: [], chunks: [{ files_id: 'a' }], pending: [{ _id: 'a', state: 'writing', expires: dead() }] };
    let { queue, calls } = makeQueue(state);
    let collection = queue.mongodb.collection;
    queue.mongodb.collection = name => {
        let result = collection(name);
        if (name === GFS + '.pending') {
            let find = result.find;
            result.find = query => {
                let cursor = find(query);
                let next = cursor.next;
                cursor.next = async () => {
                    let marker = await next();
                    state.pending[0].expires = beating();
                    return marker;
                };
                return cursor;
            };
        }
        return result;
    };
    queue.collectPendingGridfs().then(() => {
        assert.equal(state.chunks.length, 1);
        assert.equal(state.pending.length, 1);
        assert.equal(calls.filter(call => /^delete/.test(call.op)).length, 0);
        finishTest();
    }).catch(finishTest);
});

test('a collection claim fences renewals and marker removal', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { db } = fakeDb(state);
    let timers = captureTimers();
    let lost = 0;
    gridfsPending.markPending(db, GFS, 'a', 'writing', () => {
        state.pending[0].collecting = 'collector';
        let expires = state.pending[0].expires;
        timers.tick();
        setImmediate(() => {
            assert.equal(lost, 1);
            gridfsPending.renewPending(db, GFS, 'a', err => {
                assert.ok(err);
                gridfsPending.clearPending(db, GFS, 'a', err => {
                    assert.ok(err);
                    assert.equal(state.pending.length, 1);
                    assert.equal(state.pending[0].expires, expires);
                    timers.restore();
                    finishTest();
                });
            });
        });
    }, () => lost++);
});

for (let operation of ['chunks', 'files']) {
    test('a failed ' + operation + ' delete stops beating and is retried', (_t, finishTest) => {
        let state = { files: [{ _id: 'a', filename: 'message a' }], chunks: [{ files_id: 'a' }], pending: [] };
        let { queue, calls } = makeQueue(state);
        let collection = queue.mongodb.collection;
        let failure = new Error('delete failed');
        queue.mongodb.collection = name => {
            let result = collection(name);
            if (name === GFS + '.' + operation) {
                result[operation === 'chunks' ? 'deleteMany' : 'deleteOne'] = (query, cb) => setImmediate(() => cb(failure));
            }
            return result;
        };
        let timers = captureTimers();
        queue.removeGridfsFile('a', err => {
            assert.equal(err, failure);
            let updates = calls.filter(call => call.op === 'updateOne').length;
            timers.tick();
            timers.restore();
            assert.equal(calls.filter(call => call.op === 'updateOne').length, updates);
            assert.equal(state.pending.length, 1);
            assert.equal(state.pending[0].state, 'deleting');
            state.pending[0].expires = dead();
            queue.mongodb.collection = collection;
            queue.collectPendingGridfs().then(() => {
                assert.equal(state.files.length, 0);
                assert.equal(state.chunks.length, 0);
                assert.equal(state.pending.length, 0);
                finishTest();
            }).catch(finishTest);
        });
    });
}

test('an upload claimed before finishing cannot report storage success', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { queue, calls } = makeQueue(state);
    let upload = fakeUpload(calls);
    queue.gridstore = { openUploadStream: () => upload };
    let source = new PassThrough();
    queue.store('lost', source, err => {
        assert.ok(err);
        assert.equal(state.pending[0].collecting, 'collector');
        finishTest();
    });
    setImmediate(() => {
        state.pending[0].collecting = 'collector';
        source.end('body');
    });
});

test('competing collectors only delete once', (_t, finishTest) => {
    let state = { files: [], chunks: [{ files_id: 'a' }], pending: [{ _id: 'a', state: 'writing', expires: dead() }] };
    let { queue, calls } = makeQueue(state);
    Promise.all([queue.collectPendingGridfs(), queue.collectPendingGridfs()]).then(() => {
        assert.equal(calls.filter(call => call.op === 'deleteMany').length, 1);
        assert.equal(state.pending.length, 0);
        finishTest();
    }).catch(finishTest);
});

test('an upload claimed during scanning cannot enqueue deliveries', (_t, finishTest) => {
    let originalHandler = plugins.handler;
    plugins.handler = { runHooks: (name, args, cb) => cb() };
    let state = { files: [], chunks: [], pending: [{ _id: 'a', state: 'writing', expires: beating(), collecting: 'collector' }] };
    let { queue } = makeQueue(state);
    let collection = queue.mongodb.collection;
    let inserted = false;
    queue.mongodb.collection = name => {
        let result = collection(name);
        result.insertMany = () => { inserted = true; };
        return result;
    };
    queue.push('message', { to: ['recipient@example.com'], headers: {} }, err => {
        plugins.handler = originalHandler;
        assert.ok(err);
        assert.equal(inserted, false);
        finishTest();
    }, 'a');
});

test('a heartbeat aborts an open upload when collection claims it', (_t, finishTest) => {
    let state = { files: [], chunks: [], pending: [] };
    let { queue, calls } = makeQueue(state);
    let upload = fakeUpload(calls);
    queue.gridstore = { openUploadStream: () => upload };
    let source = new PassThrough();
    let timers = captureTimers();
    queue.store('lost', source, err => {
        assert.ok(err);
        assert.ok(upload.destroyed);
        timers.restore();
        finishTest();
    });
    setImmediate(() => {
        state.pending[0].collecting = 'collector';
        timers.tick();
    });
});

test('release marks the body before removing the last delivery', (_t, finishTest) => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a' }],
        pending: [],
        queue: [{ id: '1', seq: '001' }]
    };
    let { queue, calls } = makeQueue(state, { collection: 'deliveries' });
    let released;
    queue.locks.release = lock => { released = lock; };
    queue.releaseDelivery({ id: '1', seq: '001', _lock: 'lock' }, (err, removed) => {
        assert.ifError(err);
        assert.equal(removed, true);
        assert.equal(released, 'lock');
        let order = calls.map(call => call.name);
        assert.ok(order.indexOf('mail.pending') < order.indexOf('deliveries'));
        assert.equal(state.queue.length, 0);
        assert.equal(state.files.length, 0);
        assert.equal(state.chunks.length, 0);
        assert.equal(state.pending.length, 0);
        finishTest();
    });
});

test('a failed release marker keeps the delivery and releases its lock', (_t, finishTest) => {
    let state = { files: [{ _id: 'a', filename: 'message 1' }], pending: [], queue: [{ id: '1', seq: '001' }] };
    let { queue } = makeQueue(state);
    let failure = new Error('marker failed');
    let released = false;
    queue.locks.release = () => { released = true; };
    queue.markPending = (id, markerState, cb) => cb(failure);
    queue.releaseDelivery({ id: '1', seq: '001' }, err => {
        assert.equal(err, failure);
        assert.equal(state.queue.length, 1);
        assert.equal(released, true);
        finishTest();
    });
});

for (let failureAt of ['deleteOne', 'findOne']) {
    test('release interrupted at ' + failureAt + ' leaves a collectable marker', (_t, finishTest) => {
        let state = {
            files: [{ _id: 'a', filename: 'message 1' }],
            chunks: [{ files_id: 'a' }],
            pending: [],
            queue: [{ id: '1', seq: '001' }]
        };
        let { queue } = makeQueue(state, { collection: 'deliveries' });
        let collection = queue.mongodb.collection;
        let failure = new Error('release interrupted');
        queue.mongodb.collection = name => {
            let result = collection(name);
            if (name === 'deliveries') {
                let original = result[failureAt];
                result[failureAt] = async (...args) => {
                    await original(...args);
                    throw failure;
                };
            }
            return result;
        };
        let timers = captureTimers();
        queue.releaseDelivery({ id: '1', seq: '001' }, err => {
            assert.equal(err, failure);
            assert.equal(state.pending.length, 1);
            assert.equal(state.queue.length, 0);
            state.pending[0].expires = dead();
            timers.tick();
            timers.restore();
            queue.mongodb.collection = collection;
            queue.collectPendingGridfs().then(() => {
                assert.equal(state.files.length, 0);
                assert.equal(state.chunks.length, 0);
                assert.equal(state.pending.length, 0);
                finishTest();
            }).catch(finishTest);
        });
    });
}

test('collector preserves a releasing body until its remaining delivery is released', (_t, finishTest) => {
    let state = {
        files: [{ _id: 'a', filename: 'message 1' }],
        chunks: [{ files_id: 'a' }],
        pending: [],
        queue: [{ id: '1', seq: '001' }, { id: '1', seq: '002' }]
    };
    let { queue } = makeQueue(state, { collection: 'deliveries' });
    queue.releaseDelivery({ id: '1', seq: '001' }, (err, removed) => {
        assert.ifError(err);
        assert.equal(removed, false);
        assert.equal(state.pending[0].state, 'releasing');
        state.pending[0].expires = dead();
        queue.collectPendingGridfs().then(() => {
            assert.equal(state.files.length, 1);
            assert.equal(state.chunks.length, 1);
            assert.equal(state.pending.length, 1);
            assert.equal(state.pending[0].collecting, undefined);
            // Simulate a second release resuming after collection, then dying immediately
            // after its delivery delete. It must still be described by the existing marker.
            state.queue = [];
            state.pending[0].expires = dead();
            return queue.collectPendingGridfs();
        }).then(() => {
            assert.equal(state.files.length, 0);
            assert.equal(state.chunks.length, 0);
            assert.equal(state.pending.length, 0);
            finishTest();
        }).catch(finishTest);
    });
});

test('upload cleanup cannot erase a marker taken over by delivery release', (_t, finishTest) => {
    let state = { pending: [{ _id: 'a', state: 'releasing', expires: beating() }] };
    let { queue } = makeQueue(state);
    queue.clearPending('a', err => {
        assert.ok(err);
        assert.equal(state.pending.length, 1);
        assert.equal(state.pending[0].state, 'releasing');
        finishTest();
    });
});

test('a collector claim prevents a new delete from taking over the marker', (_t, finishTest) => {
    let state = { pending: [{ _id: 'a', state: 'writing', expires: beating(), collecting: 'collector' }] };
    let { queue } = makeQueue(state);
    queue.markPending('a', 'deleting', err => {
        assert.equal(err.code, 11000);
        assert.equal(state.pending.length, 1);
        assert.equal(state.pending[0].state, 'writing');
        finishTest();
    });
});

test('source error still returns when finishing the partial upload fails', (_t, finishTest) => {
    let state = { pending: [] };
    let { queue } = makeQueue(state);
    let upload = fakeUpload([]);
    upload.end = () => setImmediate(() => upload.emit('error', new Error('storage failed')));
    queue.gridstore = { openUploadStream: () => upload };
    let source = new PassThrough();
    let failure = new Error('source failed');
    let timeout = setTimeout(() => finishTest(new Error('store callback never returned')), 1000);
    queue.store('1', source, err => {
        clearTimeout(timeout);
        assert.equal(err, failure);
        assert.equal(state.pending.length, 1);
        finishTest();
    });
    setImmediate(() => source.emit('error', failure));
});

test('age based collection protects old active uploads while removing older legacy orphans', (_t, finishTest) => {
    let idAt = minutesAgo => ObjectId.createFromTime(Math.floor((Date.now() - minutesAgo * MINUTE) / 1000));
    let active = idAt(20);
    let orphan = idAt(60);
    let state = {
        files: [{ _id: active, filename: 'message active' }, { _id: orphan, filename: 'message orphan' }],
        chunks: [{ _id: idAt(19), files_id: active }, { _id: idAt(59), files_id: orphan }],
        pending: [{ _id: active, state: 'writing', expires: beating() }],
        queue: []
    };
    let { queue } = makeQueue(state);
    queue.clearGarbage().then(() => {
        assert.equal(state.files.length, 1);
        assert.equal(state.chunks.length, 1);
        assert.equal(state.pending.length, 1);
        assert.equal(String(state.files[0]._id), String(active));
        assert.equal(String(state.chunks[0].files_id), String(active));
        finishTest();
    }).catch(finishTest);
});

test('queueing a slow upload keeps its body protected from age based collection', (_t, finishTest) => {
    let filesId = ObjectId.createFromTime(Math.floor((Date.now() - 20 * MINUTE) / 1000));
    let state = {
        files: [{ _id: filesId, filename: 'message slow' }],
        chunks: [{ _id: filesId, files_id: filesId }],
        pending: [{ _id: filesId, state: 'writing', expires: beating() }],
        queue: []
    };
    let { queue } = makeQueue(state);
    let originalHandler = plugins.handler;
    plugins.handler = new PluginHandler();
    queue.store = (id, source, cb) => {
        source.once('end', () => cb(null, id, filesId));
        source.resume();
    };
    queue.setMeta = (id, data, cb) => cb();
    queue.push = (id, envelope, cb) => {
        state.queue.push({ id, _id: new ObjectId() });
        cb();
    };
    queue.maildrop.add({ id: 'slow', to: ['recipient@example.com'] }, 'Subject: slow upload\r\n\r\nbody', err => {
        plugins.handler = originalHandler;
        assert.ifError(err);
        assert.equal(state.pending.length, 1, 'the old body must still bound the GC watermark after queueing');
        if (state.pending.length) {
            state.pending[0].expires = dead();
        }
        queue.clearGarbage().then(() => {
            assert.equal(state.files.length, 1);
            assert.equal(state.chunks.length, 1);
            assert.equal(state.pending.length, 1);
            // Once the last delivery is gone, the retained writing marker also makes an
            // interrupted release recoverable; it must not keep the body forever.
            state.queue = [];
            state.pending[0].expires = dead();
            return queue.collectPendingGridfs();
        }).then(() => {
            assert.equal(state.files.length, 0);
            assert.equal(state.chunks.length, 0);
            assert.equal(state.pending.length, 0);
            finishTest();
        }).catch(finishTest);
    });
});
