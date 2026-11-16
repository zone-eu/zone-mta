/* eslint global-require:0 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// app.js supplies this Restify compatibility shim before loading APIServer on Node 24.
const originalBinding = process.binding;
let APIServer;
try {
    process.binding = function (name) {
        return name === 'http_parser' ? require('http-parser-js') : originalBinding.call(process, name);
    };
    APIServer = require('../lib/api-server');
} finally {
    process.binding = originalBinding;
}

function storeRoute(queue) {
    let api = Object.create(APIServer.prototype);
    let handler;
    api.queue = queue;
    api.server = {
        get() {},
        post() {},
        del() {},
        put(path, route) {
            if (path === '/store/:id') {
                handler = route;
            }
        }
    };
    api.setupRoutes();
    return handler;
}

test('store endpoint waits for marker removal before reporting success', (_t, finishTest) => {
    let clear;
    let response;
    let nextCalls = 0;
    let handler = storeRoute({
        store(id, source, cb) {
            cb(null, id, 'file-id');
        },
        clearPending(filesId, cb) {
            assert.equal(filesId, 'file-id');
            clear = cb;
        }
    });
    handler({ params: { id: 'message-id' } }, { json: (...args) => { response = args; } }, () => nextCalls++);
    assert.equal(response, undefined);
    assert.equal(nextCalls, 0);
    clear();
    assert.deepEqual(response, [200, { success: true }]);
    assert.equal(nextCalls, 1);
    finishTest();
});

test('store endpoint reports a failed marker removal instead of promising durability', (_t, finishTest) => {
    let handler = storeRoute({
        store(id, source, cb) {
            cb(null, id, 'file-id');
        },
        clearPending(filesId, cb) {
            cb(new Error('marker removal failed'));
        }
    });
    handler({ params: { id: 'message-id' } }, {
        json(code, body) {
            assert.equal(code, 500);
            assert.equal(body.error, 'marker removal failed');
        }
    }, () => finishTest());
});

test('store endpoint leaves a failed upload marker for collection', (_t, finishTest) => {
    let handler = storeRoute({
        store(id, source, cb) {
            cb(new Error('upload failed'));
        },
        clearPending() {
            assert.ok(false, 'a failed upload must keep its marker');
        }
    });
    handler({ params: { id: 'message-id' } }, {
        json(code, body) {
            assert.equal(code, 500);
            assert.equal(body.error, 'upload failed');
        }
    }, () => finishTest());
});
