'use strict';

const http = require('http');
const postFormData = require('../lib/post-form-data');

module.exports['Posts multipart form data'] = test => {
    const server = http.createServer((request, response) => {
        let body = Buffer.alloc(0);
        request.on('data', chunk => {
            body = Buffer.concat([body, chunk]);
        });
        request.on('end', () => {
            const value = body.toString();
            test.equal(request.method, 'POST');
            test.ok(request.headers['content-type'].startsWith('multipart/form-data; boundary='));
            test.equal(request.headers['user-agent'], 'ZoneMTA test');
            test.ok(value.includes('name="id"'));
            test.ok(value.includes('delivery.1'));
            test.ok(value.includes('name="message"; filename="delivery.eml"'));
            test.ok(value.includes('Content-Type: message/rfc822'));
            test.ok(value.includes('Subject: test'));
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
            test.equal(result.statusCode, 201);
            test.equal(result.body.toString(), 'accepted');
        } catch (err) {
            test.ifError(err);
        } finally {
            server.close(() => test.done());
        }
    });
};
