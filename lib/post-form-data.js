'use strict';

const FormData = require('form-data');
const { request } = require('undici');
const { promisify } = require('util');

module.exports = async (url, values, headers) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) {
        if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) {
            form.append(key, value.value, value.options);
        } else {
            form.append(key, value);
        }
    }

    // Some upload endpoints reject chunked requests, so include the complete multipart length.
    const contentLength = await promisify(form.getLength).call(form);

    const response = await request(url, {
        method: 'POST',
        headers: {
            ...form.getHeaders(),
            ...headers,
            'Content-Length': contentLength
        },
        body: form
    });
    const body = Buffer.from(await response.body.arrayBuffer());
    return { statusCode: response.statusCode, body };
};
