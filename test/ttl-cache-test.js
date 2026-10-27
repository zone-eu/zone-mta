'use strict';

const test = require('node:test');
const assert = require('node:assert');

const TtlCache = require('../lib/ttl-cache');

test('Set and let expire', (_t, finishTest) => {
    let cache = new TtlCache();
    let expireCbCalled = 0;

    cache.set('key1', 'val1', 403, () => {
        expireCbCalled++;
    });

    cache.set('key2', 'val2', 803, () => {
        expireCbCalled++;
    });
    cache.set('key3', 'val3', 203, () => {
        expireCbCalled++;
    });

    setTimeout(() => {
        assert.ok(!cache.get('key1'));
        assert.ok(cache.get('key2'));
        assert.ok(!cache.get('key3'));
    }, 650);

    let interval = setInterval(() => {
        let key1 = cache.get('key1');
        let key2 = cache.get('key2');
        let key3 = cache.get('key3');

        if (key3) {
            assert.equal(key1, 'val1');
            assert.equal(key2, 'val2');
            assert.equal(key3, 'val3');
        } else if (key1) {
            assert.equal(key1, 'val1');
            assert.equal(key2, 'val2');
        } else if (key2) {
            assert.equal(key2, 'val2');
        } else if (!key1 && !key2 && !key3) {
            assert.ok(expireCbCalled);
            clearInterval(interval);
            finishTest();
        }
    }, 10);
});
