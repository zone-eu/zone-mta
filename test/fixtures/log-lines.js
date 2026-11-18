'use strict';

// Started without arguments, forks a few children that share this process' stderr,
// the same way ZoneMTA sender/receiver processes share the output of the main process.
// Each child logs through npmlog at the same time.

const { fork } = require('child_process');

const CHILDREN = 4;
const LINES = 500;

if (process.argv[2] !== 'child') {
    for (let i = 0; i < CHILDREN; i++) {
        fork(__filename, ['child'], { stdio: 'inherit' });
    }
    return;
}

require('../../lib/log-setup')({});
const log = require('npmlog');

for (let i = 0; i < LINES; i++) {
    log.info(`Sender/test/${process.pid}`, 'id=%s ACCEPTED from=sender@example.com to=rcpt@example.com', i);
}
