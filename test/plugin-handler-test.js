'use strict';

const PluginHandler = require('../lib/plugin-handler');
const mailsplit = require('mailsplit');
const PassThrough = require('stream').PassThrough;

module.exports['Loading empty plugin with no init method should fail'] = test => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            noop: true
        }
    });
    plugins.load(() => {
        test.equal(plugins.loaded.length, 0);
        test.done();
    });
};

module.exports['Load plugins by order'] = test => {
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
        }
    });
    plugins.load(() => {
        test.equal(plugins.loaded.length, 2);
        test.equal(plugins.loaded[0].title, 'Order-2');
        test.equal(plugins.loaded[1].title, 'Order-1');
        test.done();
    });
};

module.exports['Load plugins with a hook'] = test => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'hook-1': true,
            'hook-2': true
        }
    });
    plugins.load(() => {
        let a = {
            incr: 0
        };
        let b = {
            incr: 15
        };
        plugins.runHooks('testhook', [a, b], err => {
            test.ifError(err);
            test.equal(a.incr, 2);
            test.equal(b.incr, 17);
            test.done();
        });
    });
};

module.exports['Load plugins with a rewriter hook'] = test => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'rewriter-1': true,
            'rewriter-2': true
        }
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
            test.ok(/HELL0 W0RLD/.test(output));
            test.done();
        });
        splitter.end('Subject: text\nContent-Type: text/plain\n\nHello world!');
    });
};

module.exports['Load plugin with an analyzer hook'] = test => {
    let plugins = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: {
            'analyzer-1': true,
            'analyzer-2': true
        }
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
            test.ok(/X-Step-1/.test(output));
            test.ok(/X-Step-2/.test(output));
            test.done();
        });
        source.end('Subject: text\nContent-Type: text/plain\n\nHello world!');
    });
};
