'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { PassThrough } = require('stream');
const PluginHandler = require('@zone-eu/wild-plugins');
const MailDrop = require('../lib/mail-drop');
const plugins = require('../lib/plugins');

for (let name of ['ClientDisconnect', 'Error']) {
    test(name + ' during store hooks does not crash or open an upload', (_t, finishTest) => {
        let originalHandler = plugins.handler;
        let hooksDone;
        plugins.handler = new PluginHandler();
        plugins.handler.runHooks = (hook, args, cb) => {
            if (hook === 'message:store') {
                hooksDone = cb;
            } else {
                return cb();
            }
        };
        let stored = false;
        let maildrop = new MailDrop({
            store(id, stream, cb) {
                stored = true;
                cb(new Error('unexpected upload'));
            },
            removeMessage(id, cb) {
                cb();
            }
        });
        let source = new PassThrough();
        let failure = Object.assign(new Error('source failed while store hooks were running'), { name });
        maildrop.add({ id: 'test' }, source, err => {
            plugins.handler = originalHandler;
            assert.equal(err, failure);
            assert.equal(stored, false);
            finishTest();
        });
        assert.doesNotThrow(() => source.emit('error', failure));
        hooksDone();
    });
}
