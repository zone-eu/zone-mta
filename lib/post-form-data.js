'use strict';

const FormData = require('form-data');
const { request } = require('undici');

module.exports = async (url, values, headers) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) {
        if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) {
            form.append(key, value.value, value.options);
        } else {
            form.append(key, value);
        }
    }

    const response = await request(url, {
        method: 'POST',
        headers: {
            ...form.getHeaders(),
            ...headers
        },
        body: form
    });
    const body = Buffer.from(await response.body.arrayBuffer());
    return { statusCode: response.statusCode, body };
};
