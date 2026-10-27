'use strict';

const test = require('node:test');
const assert = require('node:assert');

const http = require('http');
const postFormData = require('../lib/post-form-data');

test('Posts multipart form data', (_t, finishTest) => {
    const server = http.createServer((request, response) => {
        let body = Buffer.alloc(0);
        request.on('data', chunk => {
            body = Buffer.concat([body, chunk]);
        });
        request.on('end', () => {
            const value = body.toString();
            assert.equal(request.method, 'POST');
            assert.ok(request.headers['content-type'].startsWith('multipart/form-data; boundary='));
            assert.equal(request.headers['user-agent'], 'ZoneMTA test');
            assert.ok(value.includes('name="id"'));
            assert.ok(value.includes('delivery.1'));
            assert.ok(value.includes('name="message"; filename="delivery.eml"'));
            assert.ok(value.includes('Content-Type: message/rfc822'));
            assert.ok(value.includes('Subject: test'));
            response.writeHead(201);
            response.end('accepted');
        });
    });

    server.listen(0, '127.0.0.1', async () => {
        try {
            const address = server.address();
            const result = await postFormData(
                `http://127.0.0.1:${address.port}`,
                {
                    id: 'delivery.1',
                    message: {
                        value: Buffer.from('Subject: test\r\n\r\nbody'),
                        options: {
                            filename: 'delivery.eml',
                            contentType: 'message/rfc822'
                        }
                    }
                },
                { 'User-Agent': 'ZoneMTA test' }
            );
            assert.equal(result.statusCode, 201);
            assert.equal(result.body.toString(), 'accepted');
        } catch (err) {
            assert.ifError(err);
        } finally {
            server.close(() => finishTest());
        }
    });
});
