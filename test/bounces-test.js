'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bounces = require('../lib/bounces');

test('Defer and blacklist a rejection that names the sender IP', () => {
    let bounce = bounces.check('554 5.7.1 You are not allowed to connect.');
    assert.equal(bounce.action, 'defer');
    assert.equal(bounce.category, 'blacklist');
    assert.equal(bounce.code, 554);
});

test('Reject an unrecognized permanent response', () => {
    let bounce = bounces.check('599 zzqq totally unknown gibberish');
    assert.equal(bounce.action, 'reject');
    assert.equal(bounce.category, 'other');
    assert.equal(bounce.code, 599);
});

test('Defer an unrecognized transient response', () => {
    let bounce = bounces.check('499 zzqq totally unknown gibberish');
    assert.equal(bounce.action, 'defer');
    assert.equal(bounce.category, 'other');
    assert.equal(bounce.code, 499);
});

test('Keep the caller category when there is no response to classify', () => {
    let bounce = bounces.check('', 'network');
    assert.equal(bounce.action, 'reject');
    assert.equal(bounce.category, 'network');
});

test('Strip a leading CRLF or space ahead of the status code', () => {
    // handleResponseError's has-a-code guard relies on this: a permanent 5xx that arrives
    // with leading whitespace must still expose its code, or it defers forever.
    assert.equal(bounces.formatSMTPResponse('\r\n550 5.1.1 no such user'), '550 5.1.1 no such user');
    assert.equal(bounces.formatSMTPResponse('  550 5.1.1 no such user'), '550 5.1.1 no such user');
});

test('Classify a rejection that arrives with a leading newline', () => {
    let bounce = bounces.check('\r\n554 5.7.1 You are not allowed to connect.');
    assert.equal(bounce.action, 'defer');
    assert.equal(bounce.category, 'blacklist');
});
