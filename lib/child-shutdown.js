'use strict';

const log = require('npmlog');

// Only the master process receives SIGTERM/SIGINT, so it notifies its forked children over
// the IPC channel when the server is stopping. A child that gets { shutdown: true } stops
// taking new work, finishes what it already has in hand and exits. The master waits for the
// children to exit before closing the queue server, otherwise a child would lose its only
// channel back to the queue mid-delivery.
module.exports.notifyChildren = (children, logName) => {
    children.forEach(child => {
        if (child.connected === false) {
            return;
        }
        let logFailure = err => err && log.info(logName + '/' + child.pid, 'Failed to notify child process about shutdown. %s', err.message);
        try {
            child.send({ shutdown: true }, logFailure);
        } catch (err) {
            // IPC channel already closed
            logFailure(err);
        }
    });
};
