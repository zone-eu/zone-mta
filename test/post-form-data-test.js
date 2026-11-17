'use strict';

const test = require('node:test');
const assert = require('node:assert');

const http = require('http');
const { once } = require('events');
const postFormData = require('../lib/post-form-data');

test('Posts multipart form data with an exact Content-Length instead of chunked encoding', async t => {
    const messageContent = Buffer.from('Subject: test\r\n\r\nbody \u00fc');
    let received;
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        received = { method: request.method, headers: request.headers, body: Buffer.concat(chunks) };
        response.writeHead(201);
        response.end('accepted');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));

    const result = await postFormData(
        `http://127.0.0.1:${server.address().port}`,
        {
            id: 'delivery.1',
            'headers[subject]': JSON.stringify('Upload test \u00fc'),
            'mail_to_http[real_length]': messageContent.length,
            'mail_to_http[body]': messageContent,
            message: {
                value: messageContent,
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
    assert.equal(received.method, 'POST');
    assert.equal(received.headers['content-length'], String(received.body.length));
    assert.equal(received.headers['transfer-encoding'], undefined);
    assert.ok(received.headers['content-type'].startsWith('multipart/form-data; boundary='));
    assert.equal(received.headers['user-agent'], 'ZoneMTA test');
    assert.ok(received.body.includes(messageContent));

    const value = received.body.toString();
    assert.ok(value.includes('name="id"'));
    assert.ok(value.includes('delivery.1'));
    assert.ok(value.includes('name="mail_to_http[real_length]"'));
    assert.ok(value.includes('name="mail_to_http[body]"'));
    assert.ok(value.includes('name="message"; filename="delivery.eml"'));
    assert.ok(value.includes('Content-Type: message/rfc822'));
});
