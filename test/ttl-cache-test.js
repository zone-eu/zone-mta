'use strict';

const TtlCache = require('../lib/ttl-cache');

module.exports['Set and let expire'] = test => {
    let cache = new TtlCache();
    let expireCbCalled = 0;

    cache.set('key1', 'val1', 300, () => {
        expireCbCalled++;
    });

    cache.set('key2', 'val2', 400, () => {
        expireCbCalled++;
    });
    cache.set('key3', 'val3', 200, () => {
        expireCbCalled++;
    });

    setTimeout(() => {
        test.ok(!cache.get('key1'));
        test.ok(cache.get('key2'));
        test.ok(!cache.get('key3'));
    }, 350);

    let interval = setInterval(() => {
        let key1 = cache.get('key1');
        let key2 = cache.get('key2');
        let key3 = cache.get('key3');

        if (key3) {
            test.equal(key1, 'val1');
            test.equal(key2, 'val2');
            test.equal(key3, 'val3');
        } else if (key1) {
            test.equal(key1, 'val1');
            test.equal(key2, 'val2');
        } else if (key2) {
            test.equal(key2, 'val2');
        } else {
            test.equal(expireCbCalled, 3);
            clearInterval(interval);
            test.done();
        }
    }, 10);
};
