'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dns = require('dns');
const config = require('@zone-eu/wild-config');

// ip-tools captures this setting when loaded. Exercise caching regardless of local config.
const originalCaching = config.dns.caching;
let ipTools;
try {
    config.dns.caching = true;
    ipTools = require('../lib/ip-tools'); // eslint-disable-line global-require
} finally {
    config.dns.caching = originalCaching;
}

test('Adds the cache-backed resolver for mx-connect', () => {
    const input = { blockReservedNetworks: true };
    const result = ipTools.getMxConnectDnsOptions(input);

    assert.notStrictEqual(result, input);
    assert.equal(result.blockReservedNetworks, true);
    assert.equal(typeof result.resolveRecords, 'function');
    assert.ok(!('resolveRecords' in input));
});

test('Preserves delivery-specific mx-connect resolvers', () => {
    const resolveRecords = () => [];
    const promiseOptions = { resolveRecords };
    const callbackOptions = { resolve() {} };

    assert.strictEqual(ipTools.getMxConnectDnsOptions(promiseOptions), promiseOptions);
    assert.strictEqual(ipTools.getMxConnectDnsOptions(promiseOptions).resolveRecords, resolveRecords);
    assert.strictEqual(ipTools.getMxConnectDnsOptions(callbackOptions), callbackOptions);
});

test('Routes the mx-connect resolver through the patched DNS API', async () => {
    const originalResolve = dns.resolve;
    const expected = ['192.0.2.1'];
    const options = ipTools.getMxConnectDnsOptions({});

    dns.resolve = (domain, type, callback) => {
        assert.equal(domain, 'mx.example');
        assert.equal(type, 'A');
        setImmediate(callback, null, expected);
    };

    try {
        const records = await options.resolveRecords('mx.example', 'A');
        assert.strictEqual(records, expected);
    } finally {
        dns.resolve = originalResolve;
    }
});
