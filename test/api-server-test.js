'use strict';

const test = require('node:test');
const assert = require('node:assert');

const APIServer = require('../lib/api-server');
const plugins = require('../lib/plugins');

function invoke(api, routeName, body) {
    return new Promise((resolve, reject) => {
        let response;
        let req = {
            body,
            connection: {
                remoteAddress: '127.0.0.1'
            },
            header() {
                return false;
            }
        };
        let res = {
            json(statusCode, responseBody) {
                response = { statusCode, body: responseBody };
                resolve(response);
            }
        };
        let handler = api.server.router._registry._routes[routeName].chain._stack[0];

        try {
            handler(req, res, err => {
                if (err) {
                    return reject(err);
                }
                if (!response) {
                    reject(new Error('Route completed without a response'));
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

test('Send API does not expose internal queue errors', (_t, finishTest) => {
    let originalHandler = plugins.handler;
    let api = new APIServer();
    let failurePoint = 'hook';
    let internalMessage = 'getaddrinfo EAI_AGAIN mongodb.internal';

    api.setQueue({
        seqIndex: {
            get() {
                return 'test-id';
            }
        }
    });

    plugins.handler = {
        runHooks(name, args, callback) {
            setImmediate(() => callback(failurePoint === 'hook' ? new Error(internalMessage) : null));
        }
    };

    api.maildrop.add = (envelope, source, callback) => setImmediate(() => callback(new Error(internalMessage)));

    (async () => {
        try {
            let message = {
                from: 'sender@example.com',
                to: 'recipient@example.com',
                subject: 'Test',
                text: 'Message body'
            };

            for (let routeName of ['postsend', 'postsendraw']) {
                let response = await invoke(api, routeName, message);
                assert.equal(response.statusCode, 500);
                assert.deepEqual(response.body, { error: 'Failed to queue message' });
                assert.ok(!JSON.stringify(response.body).includes(internalMessage));
            }

            failurePoint = 'maildrop';

            for (let routeName of ['postsend', 'postsendraw']) {
                let response = await invoke(api, routeName, message);
                assert.equal(response.statusCode, 500);
                assert.deepEqual(response.body, { error: 'Failed to queue message' });
                assert.ok(!JSON.stringify(response.body).includes(internalMessage));
            }

            api.maildrop.add = (envelope, source, callback) => {
                let err = new Error('Message rejected by policy');
                err.name = 'SMTPResponse';
                setImmediate(() => callback(err));
            };

            for (let routeName of ['postsend', 'postsendraw']) {
                let response = await invoke(api, routeName, message);
                assert.equal(response.statusCode, 200);
                assert.deepEqual(response.body, { message: 'Message rejected by policy' });
            }
        } catch (err) {
            assert.ifError(err);
        } finally {
            plugins.handler = originalHandler;
            finishTest();
        }
    })();
});
