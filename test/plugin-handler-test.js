'use strict';

const test = require('node:test');
const assert = require('node:assert');

const PluginHandler = require('@zone-eu/wild-plugins');
const mailsplit = require('@zone-eu/mailsplit');
const PassThrough = require('stream').PassThrough;

test('Loading empty plugin with no init method should fail', (_t, finishTest) => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            noop: true
        }
    });
    plugins.load(() => {
        assert.equal(plugins.loaded.length, 0);
        finishTest();
    });
});

test('Load plugins by order', (_t, finishTest) => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'order-1': {
                enabled: true,
                ordering: 2
            },
            'order-2': {
                enabled: true,
                ordering: 1
            }
        },
        db: {},
        log: {}
    });
    plugins.load(() => {
        assert.equal(plugins.loaded.length, 2);
        assert.equal(plugins.loaded[0].title, 'Order-2');
        assert.equal(plugins.loaded[1].title, 'Order-1');
        finishTest();
    });
});

test('Load plugins with a hook', (_t, finishTest) => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'hook-1': true,
            'hook-2': true
        },
        db: {},
        log: {}
    });
    plugins.load(() => {
        let a = {
            incr: 0
        };
        let b = {
            incr: 15
        };
        plugins.runHooks('testhook', [a, b], err => {
            assert.ifError(err);
            assert.equal(a.incr, 2);
            assert.equal(b.incr, 17);
            finishTest();
        });
    });
});

test('Load plugins with a rewriter hook', (_t, finishTest) => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'rewriter-1': true,
            'rewriter-2': true
        },
        db: {},
        log: {}
    });
    plugins.load(() => {
        let splitter = new mailsplit.Splitter();
        let joiner = new mailsplit.Joiner();

        plugins.runRewriteHooks(
            {
                test: true
            },
            splitter,
            joiner
        );

        let output = '';
        joiner.on('data', chunk => {
            output += chunk.toString();
        });
        joiner.on('end', () => {
            assert.ok(/HELL0 W0RLD/.test(output));
            finishTest();
        });
        splitter.end('Subject: text\nContent-Type: text/plain\n\nHello world!');
    });
});

test('Load plugin with an analyzer hook', (_t, finishTest) => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'analyzer-1': true,
            'analyzer-2': true
        },
        db: {},
        log: {}
    });
    plugins.load(() => {
        let source = new PassThrough();
        let destination = new PassThrough();

        plugins.runAnalyzerHooks(
            {
                test: true
            },
            source,
            destination
        );

        let output = '';
        destination.on('data', chunk => {
            output += chunk.toString();
        });
        destination.on('end', () => {
            assert.ok(/X-Step-1/.test(output));
            assert.ok(/X-Step-2/.test(output));
            finishTest();
        });
        source.end('Subject: text\nContent-Type: text/plain\n\nHello world!');
    });
});
