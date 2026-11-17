'use strict';

const gridfsPending = require('./gridfs-pending');

// Shared by the local API queue and the SMTP child's remote queue. The upload heartbeat
// continues after finish until the caller queues the message or explicitly releases it.
// A marker can remain after that handoff when the queued body still needs age-based GC protection.
module.exports = (queue, gfs, id, source, callback, onSourceError) => {
    let store = queue.gridstore.openUploadStream('message ' + id, {
        contentType: 'message/rfc822',
        metadata: { created: new Date() }
    });
    let returned = false;
    let sourceError;

    const done = err => {
        if (returned) {
            return;
        }
        returned = true;
        if (err) {
            source.unpipe(store);
            gridfsPending.stopPending(store.id);
        }
        callback(err, id, store.id);
    };

    source.once('error', err => {
        if (returned || sourceError) {
            return;
        }
        sourceError = err;
        source.unpipe(store);
        gridfsPending.stopPending(store.id);
        if (onSourceError) {
            onSourceError(err);
        }
        // Finish the partial upload so removeMessage can find it. If this also fails, the
        // error handler must still notify the caller; the marker covers any leftover chunks.
        store.end();
    });

    store.on('error', err => done(sourceError || err));
    store.once('finish', () => {
        if (returned) {
            return;
        }
        if (sourceError) {
            return queue.removeMessage(id, () => done(sourceError));
        }
        // The files document now exists, but a stored message without a delivery still
        // belongs to nobody. Keep the heartbeat running through scanning and queue insertion.
        // Return files_id so the caller can complete the marker only after that handoff succeeds.
        // Renew here as well: collection may have claimed the marker before the next beat.
        gridfsPending.renewPending(queue.mongodb, gfs, store.id, done);
    });

    // The pipe waits for the marker write, so hold the source until then. Callers normally
    // pass a paused stream, but a source already flowing would otherwise lose data while
    // Mongo acknowledges the marker.
    source.pause();

    // openUploadStream assigns files_id immediately, but GridFS does not insert the files
    // document until finish. Write the marker before piping the first chunk so the collector
    // can distinguish an abandoned upload from a live one throughout that window.
    gridfsPending.markPending(queue.mongodb, gfs, store.id, 'writing', err => {
        if (returned || sourceError) {
            // The source failed while the marker write was pending. Its error handler stopped
            // before this heartbeat existed, so this callback must stop the newly created timer.
            gridfsPending.stopPending(store.id);
            return;
        }
        if (err) {
            // Nothing was piped into the upload, and nobody will end the unused handle now.
            store.destroy();
            return done(err);
        }
        source.pipe(store);
    }, err => {
        source.unpipe(store);
        store.destroy(err);
    });
};
