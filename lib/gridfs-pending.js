'use strict';

const log = require('npmlog');

// Marker bookkeeping for in-flight GridFS operations, shared by both queue implementations.
//
// GridFS writes chunks as they arrive but inserts the files document only when the upload stream
// finishes, so between the first chunk and that insert the chunks belong to nothing and no query
// can tell they are an upload in progress. The marker covers that window: it goes in before the
// first chunk and comes out once the message is queued, and the GC collects whatever is left
// behind. A delete uses the same record for the mirror-image window between its two deletes.
//
// A marker carries the moment it stops being anybody's, and the process holding the operation
// pushes that moment forward for as long as it is still holding it. So the marker means one
// thing, checkable by any process against the clock alone: nothing has been alive behind this
// since then.
//
// The heartbeat is a timer in the very process doing the writing, so it cannot outlive it. A
// child killed, out of memory, or thrown out of its event loop takes its timers with it and the
// marker goes stale on its own - there is no cleanup path that has to run first. That is the
// whole reason the deadline is a heartbeat rather than a window derived from a timeout: a
// timeout describes what should happen, a missed heartbeat is what did.

const HEARTBEAT_INTERVAL = 60 * 1000;

// Two missed beats are a slow moment, three are a death. Long enough that a stalled Mongo does
// not orphan a live upload, short enough that a real orphan is collected in minutes.
const MARKER_TTL = 3 * HEARTBEAT_INTERVAL;

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
 * @param {String} state Either 'writing' or 'deleting'
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
                if (err) {
                    // The deadline stands instead. Two more beats have to fail before the
                    // collector may act, so one bad moment costs nothing but this line.
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
 */
function clearPending(mongodb, gfs, filesId, callback) {
    stopPending(filesId);
    mongodb.collection(gfs + '.pending').deleteOne({ _id: filesId, collecting: { $exists: false } }, (err, result) => {
        callback(err || (!result.deletedCount ? new Error('GridFS operation lost its pending marker') : null));
    });
}

// Renew immediately before reporting storage success or handing the body to the queue.
// A claimed marker is fenced out even if the next interval has not fired yet.
function renewPending(mongodb, gfs, filesId, callback) {
    beat(mongodb, gfs, filesId, (err, found) => {
        callback(err || (!found ? new Error('GridFS operation lost its pending marker') : null));
    });
}

module.exports = { renewPending, markPending, clearPending, stopPending, HEARTBEAT_INTERVAL, MARKER_TTL };
