'use strict';

class SharedIterator {
    constructor(queue, name, options) {
        this.name = name;
        this.db = queue.db;
        this.iterators = queue.iterators;
        this.options = options;

        this.resetTimeout = false;

        this.iterator = false;
        this.nextQueue = [];
        this.inProgress = false;
        this.closing = false;
        this.idleTimeout = false;
    }

    close() {
        clearTimeout(this.idleTimeout);
        clearTimeout(this.resetTimeout);
        this.resetTimeout = false;

        let cb;

        this.closing = true;

        // return all pending callbacks with empty value
        while (this.nextQueue.length) {
            cb = this.nextQueue.shift();
            setImmediate(cb);
        }

        if (this.inProgress) {
            // in the middle of current iteration, wait until it finishes
            this.nextQueue.push(() => this.removeIterator());
        } else {
            this.removeIterator();
        }
    }

    removeIterator() {
        clearTimeout(this.resetTimeout);
        if (this.iterator) {
            this.iterator.end(() => false);
            this.iterator = false;
            this.iterators.delete(this.name);
        }
    }

    getNext(callback) {
        if (!this.iterator) {
            // no iterator exists, create a new one
            this.iterator = this.db.db.iterator(this.options);
            this.iterator.itemCount = 0;
        }
        // fetch next item
        this.iterator.next((err, key, value) => {
            if (err) {
                this.iterator = false;
                return callback(err);
            }
            if (typeof key === 'undefined') {
                // nothing found, clear the iterator

                if (!this.resetTimeout) {
                    if (!this.iterator.itemCount) {
                        // keep this iterator alive for a second, this is needed to prevent creating a separate
                        // empty iterator for every client if there's nothing to iterate on
                        this.resetTimeout = setTimeout(() => this.removeIterator(), 1000);
                    } else {
                        // we reached to an end of an iterator that had some data in it
                        // maybe there's more, so we do not wait until we can create a new one
                        this.removeIterator();
                    }
                }

                return setImmediate(() => callback(null, false));
            }
            this.iterator.itemCount++;
            // found something!
            return callback(null, key, value);
        });
    }

    next(callback) {
        clearTimeout(this.idleTimeout);
        if (this.closing) {
            // already closing, skip
            return setImmediate(() => callback(null, false));
        }

        // push the callback to the queue
        this.nextQueue.push(callback);
        if (this.inProgress) {
            return;
        }
        this.inProgress = true;

        let iterate = () => {
            if (!this.nextQueue.length) {
                // all done!
                this.inProgress = false;
                // If this iterator is not needed in 3 seconds, delete it
                // Most probably there's a stalling send so no point continuing,
                // just start over once it's done
                this.idleTimeout = setTimeout(() => {
                    clearTimeout(this.idleTimeout);
                    this.removeIterator();
                }, 3 * 1000);
                return;
            }
            // get next callback to return
            let done = this.nextQueue.shift();
            if (this.closing) {
                // do not iterate any more once already closing
                return done(null, false);
            }
            // try to fetch next item from the queue
            this.getNext((err, key, value) => {
                // next iteration if queued items
                setImmediate(iterate);

                // return the result for current iteration
                done(err, key, value);
            });
        };
        iterate();
    }
}

module.exports = SharedIterator;
