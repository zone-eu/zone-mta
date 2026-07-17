'use strict';

const bounces = require('../lib/bounces');

module.exports['Defer and blacklist a rejection that names the sender IP'] = test => {
    let bounce = bounces.check('554 5.7.1 You are not allowed to connect.');
    test.equal(bounce.action, 'defer');
    test.equal(bounce.category, 'blacklist');
    test.equal(bounce.code, 554);
    test.done();
};

module.exports['Reject an unrecognized permanent response'] = test => {
    let bounce = bounces.check('599 zzqq totally unknown gibberish');
    test.equal(bounce.action, 'reject');
    test.equal(bounce.category, 'other');
    test.equal(bounce.code, 599);
    test.done();
};

module.exports['Defer an unrecognized transient response'] = test => {
    let bounce = bounces.check('499 zzqq totally unknown gibberish');
    test.equal(bounce.action, 'defer');
    test.equal(bounce.category, 'other');
    test.equal(bounce.code, 499);
    test.done();
};

module.exports['Keep the caller category when there is no response to classify'] = test => {
    let bounce = bounces.check('', 'network');
    test.equal(bounce.action, 'reject');
    test.equal(bounce.category, 'network');
    test.done();
};
