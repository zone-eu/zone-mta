#!/usr/bin/env node

/* eslint no-unused-expressions: 0, global-require: 0, no-console: 0 */
'use strict';

const bounces = require('../lib/bounces');

let chunks = [];

process.stdin.on('data', chunk => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    let str = Buffer.concat(chunks)
        .toString()
        .trim();
    let bounceInfo = bounces.check(str);
    console.log('data     : %s', str.replace(/\n/g, '\n' + ' '.repeat(11)));
    Object.keys(bounceInfo || {}).forEach(key => {
        console.log('%s %s: %s', key, ' '.repeat(8 - key.length), bounceInfo[key]);
    });
});
