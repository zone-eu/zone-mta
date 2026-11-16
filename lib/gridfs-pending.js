'use strict';

const log = require('npmlog');

// Marker bookkeeping for GridFS operations, shared by both queue implementations.
//
// GridFS writes chunks as they arrive but inserts the files document only when the upload
// finishes. A 'writing' marker records files_id before the first chunk, so an interrupted
// upload remains discoverable even if it never produces a files document. Its heartbeat
// continues through scanning, metadata updates and queue insertion, which write no chunks.
//
// A 'releasing' marker is written before removing a delivery. It covers the gap between the
// last delivery disappearing and body deletion starting. A 'deleting' marker then covers
// removal of the chunks followed by the files document. Markers for shared bodies remain
// until the body is removed, because another delivery release may already depend on them.
// A slow upload also keeps its writing marker after queueing: its older files_id must keep
// bounding the age-based GC watermark even though the delivery documents are much newer.
//
// Each marker carries an absolute deadline renewed by the process holding the operation.
// A collector in another process needs only that deadline and the clock; it does not need
// to know the writer's configuration. If the writer dies or its event loop stops running,
// its timer cannot renew the marker, so cleanup does not depend on a shutdown handler.

const HEARTBEAT_INTERVAL = 60 * 1000;

// The three-interval lease tolerates two missed beats before collection can claim an
// operation. A successful renewal extends it; an expired lease gives the collector ownership.
const MARKER_TTL = 3 * HEARTBEAT_INTERVAL;

// The coarse GC subtracts this from its watermark. An upload that predates queue insertion
// by this much needs its marker after queueing too, or the delivery's newer _id cannot protect it.
const GC_GRACE_PERIOD = 10 * 60 * 1000;

// Heartbeats in flight in this process, by marker id. Module level because the id is unique and
// because both queues, and the API path, hand the same marker between them.
const heartbeats = new Map();

function key(filesId) {
    return String(filesId);
}

function deadline() {
    return new Date(Date.now() + MARKER_TTL);
}

function writeMarker(mongodb, gfs, filesId, state, callback) {
    // Upserted rather than inserted: a delete of a file whose upload marker was never
    // cleared has to take the marker over instead of colliding with it.
    // An upsert against a claimed marker fails on its unique _id rather than taking
    // cleanup away from the collector.
    mongodb.collection(gfs + '.pending').updateOne(
        { _id: filesId, collecting: { $exists: false } },
        { $set: { state, expires: deadline() } },
        { upsert: true },
        err => callback(err)
    );
}

/**
 * Pushes an existing marker's deadline forward, and reports whether there was one
 *
 * Deliberately not an upsert. The operation an id belongs to can be ended by a different process
 * than the one beating for it - a child hands its cleanup to the master over IPC - and a beat
 * that could create would raise the marker from the dead there and then go on beating for it
 * forever. Only extending means the beat has nothing to say once the marker is gone, which is
 * also how it learns to stop.
 */
function beat(mongodb, gfs, filesId, callback) {
    mongodb.collection(gfs + '.pending').updateOne({ _id: filesId, collecting: { $exists: false } }, { $set: { expires: deadline() } }, (err, result) => {
        if (err) {
            return callback(err);
        }
        callback(null, !!result && result.matchedCount > 0);
    });
}

/**
 * Records that an upload or a delete is in flight, and starts its heartbeat
 *
 * @param {Object} mongodb Database handle
 * @param {String} gfs Bucket name, so the collection is <gfs>.pending
 * @param {ObjectId} filesId Identifier of the GridFS file
 * @param {String} state 'writing', 'releasing', or 'deleting'
 * @param {Function} callback
 * @param {Function} [onLost] Aborts an upload whose marker was claimed or removed
 */
function markPending(mongodb, gfs, filesId, state, callback, onLost) {
    writeMarker(mongodb, gfs, filesId, state, err => {
        if (err) {
            return callback(err);
        }

        stopPending(filesId);

        let timer = setInterval(() => {
            beat(mongodb, gfs, filesId, (err, found) => {
                // Stopping a timer does not cancel a Mongo request already in flight. An old
                // response must not stop a new operation's heartbeat or call its former owner.
                if (heartbeats.get(key(filesId)) !== timer) {
                    return;
                }
                if (err) {
                    // Leave the last deadline in place. Later beats can recover, but if no
                    // renewal succeeds before expiry the collector may claim the operation.
                    return log.info('Queue', 'Failed to refresh the marker for %s. %s', filesId, err.message);
                }
                if (!found) {
                    // The operation was completed elsewhere or claimed for collection.
                    stopPending(filesId);
                    if (onLost) {
                        onLost(new Error('GridFS operation lost its pending marker'));
                    }
                }
            });
        }, HEARTBEAT_INTERVAL);

        // Nothing here is worth holding the process open for.
        timer.unref();
        heartbeats.set(key(filesId), timer);

        callback();
    });
}

/**
 * Stops the heartbeat but leaves the marker, for an operation that failed partway
 *
 * The chunks it wrote are exactly what the collector is looking for, so the marker has to be
 * allowed to go stale rather than be taken back.
 *
 * @param {ObjectId} filesId Identifier of the GridFS file
 */
function stopPending(filesId) {
    let timer = heartbeats.get(key(filesId));
    if (timer) {
        clearInterval(timer);
        heartbeats.delete(key(filesId));
    }
}

/**
 * Removes the marker for a completed upload or delete, and stops its heartbeat
 *
 * @param {Object} mongodb Database handle
 * @param {String} gfs Bucket name, so the collection is <gfs>.pending
 * @param {ObjectId} filesId Identifier of the GridFS file
 * @param {Function} callback
 * @param {String} [state] Expected marker state
 */
function clearPending(mongodb, gfs, filesId, callback, state) {
    stopPending(filesId);
    let query = { _id: filesId, collecting: { $exists: false } };
    if (state) {
        // A delivery may finish before its upload caller clears the writing marker. That
        // caller must not remove a releasing marker now protecting the delivery's release.
        query.state = state;
    }
    mongodb.collection(gfs + '.pending').deleteOne(query, (err, result) => {
        callback(err || (!result.deletedCount ? new Error('GridFS operation lost its pending marker') : null));
    });
}

/**
 * Ends the upload heartbeat once deliveries own the body
 *
 * Usually the writing marker can now be removed. A slow upload has an older files_id than
 * its delivery documents, though, and can fall below the age-based GC watermark immediately.
 * Keep its marker until the last delivery is released so that pass still accounts for the body.
 * The store-only API uses clearPending directly because it does not create deliveries.
 */
function completePending(mongodb, gfs, filesId, callback) {
    if (filesId.getTimestamp().getTime() <= Date.now() - GC_GRACE_PERIOD) {
        stopPending(filesId);
        return setImmediate(callback);
    }
    clearPending(mongodb, gfs, filesId, callback, 'writing');
}

// Renew immediately before reporting storage success or handing the body to the queue.
// A claimed marker is fenced out even if the next interval has not fired yet.
function renewPending(mongodb, gfs, filesId, callback) {
    beat(mongodb, gfs, filesId, (err, found) => {
        callback(err || (!found ? new Error('GridFS operation lost its pending marker') : null));
    });
}

module.exports = { renewPending, markPending, clearPending, completePending, stopPending, HEARTBEAT_INTERVAL, MARKER_TTL, GC_GRACE_PERIOD };
