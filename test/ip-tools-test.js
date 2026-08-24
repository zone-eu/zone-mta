'use strict';

const dns = require('dns');
const ipTools = require('../lib/ip-tools');

module.exports['Adds the cache-backed resolver for mx-connect'] = test => {
    const input = { blockReservedNetworks: true };
    const result = ipTools.getMxConnectDnsOptions(input);

    test.notStrictEqual(result, input);
    test.equal(result.blockReservedNetworks, true);
    test.equal(typeof result.resolveRecords, 'function');
    test.ok(!('resolveRecords' in input));
    test.done();
};

module.exports['Preserves delivery-specific mx-connect resolvers'] = test => {
    const resolveRecords = () => [];
    const promiseOptions = { resolveRecords };
    const callbackOptions = { resolve() {} };

    test.strictEqual(ipTools.getMxConnectDnsOptions(promiseOptions), promiseOptions);
    test.strictEqual(ipTools.getMxConnectDnsOptions(promiseOptions).resolveRecords, resolveRecords);
    test.strictEqual(ipTools.getMxConnectDnsOptions(callbackOptions), callbackOptions);
    test.done();
};

module.exports['Routes the mx-connect resolver through the patched DNS API'] = test => {
    const originalResolve = dns.resolve;
    const expected = ['192.0.2.1'];
    const options = ipTools.getMxConnectDnsOptions({});

    dns.resolve = (domain, type, callback) => {
        test.equal(domain, 'mx.example');
        test.equal(type, 'A');
        setImmediate(callback, null, expected);
    };

    options.resolveRecords('mx.example', 'A').then(
        records => {
            dns.resolve = originalResolve;
            test.strictEqual(records, expected);
            test.done();
        },
        err => {
            dns.resolve = originalResolve;
            test.ifError(err);
            test.done();
        }
    );
};
