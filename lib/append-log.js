'use strict';

const fs = require('fs');
const path = require('path');
const log = require('npmlog');

class AppendLog {
    constructor(options) {
        options = options || {};

        this.fnamePrefix = options.fnamePrefix;
        this.folder = options.folder;
        this.logId = options.logId;

        this.fname = false;
        this.fd = false;

        this.unacked = new Set();
        this.compacting = false;
        this.compactTimeout = false;

        this.rows = 0;
        this.fscount = 0;
    }

    init() {
        if (this.fd) {
            return;
        }
        this.fname = path.join(this.folder, this.fnamePrefix + '-' + (++this.fscount) + '.log');
        this.rows = 0;
        this.fd = fs.createWriteStream(this.fname);
        this.fd.once('error', err => {
            log.error(this.logId, 'Append log file error');
            log.error(this.logId, err.message);
            return process.exit(16);
        });

        // write old data
        if (this.unacked.size) {
            this.rows = this.unacked.size;
            this.fd.write(Array.from(this.unacked).map(key => '?:' + key).join('\n') + '\n');
        }
    }

    add(key) {
        if (!this.fd) {
            this.init();
        }
        this.rows++;

        this.unacked.add(key);
        this.fd.write('?:' + key + '\n');

        this.checkCompaction();
    }

    remove(key) {
        if (!this.fd) {
            this.init();
        }
        this.rows++;

        this.unacked.delete(key);
        this.fd.write('0:' + key + '\n');

        this.checkCompaction();
    }

    checkCompaction() {
        clearTimeout(this.compactTimeout);
        if (this.rows - this.unacked.size > 1000) {
            this.compact();
        } else {
            this.compactTimeout = setTimeout(() => {
                if (this.unacked.size !== this.rows) {
                    this.compact();
                }
            }, 60 * 1000);
            this.compactTimeout.unref();
        }
    }

    compact() {
        clearTimeout(this.compactTimeout);
        if (this.compacting || !this.fd) {
            return false;
        }
        this.compacting = true;

        let fd = this.fd;
        let fname = this.fname;

        this.fd = false;
        this.fname = false;

        fd.once('close', () => {
            fd.removeAllListeners('error');
            // remove old log file
            fs.unlink(fname, err => {
                if (err) {
                    log.error(this.logId, 'Could not unlink log file: %s', err.message);
                }
                this.compacting = false;
            });
            // create new log file if we have unacked values in memory
            if (this.unacked.size) {
                this.init();
            }
        });
        fd.end();
    }
}

module.exports = AppendLog;
