'use strict';

const path = require('path');
const log = require('npmlog');
const mailsplit = require('mailsplit');
const PassThrough = require('stream').PassThrough;

class PluginInstance {
    constructor(manager, options) {
        this.manager = manager;
        this.options = options || {};
        this.config = options.config || {};
    }

    addHook(name, action) {
        this.manager.addHook(this.options.title, name, action);
    }

    addRewriteHook(filterFunc, eventHandler) {
        this.manager.rewriters.add({
            title: this.options.title,
            filterFunc,
            eventHandler
        });
    }

    addAnalyzerHook(eventHandler) {
        this.manager.analyzers.add({
            title: this.options.title,
            eventHandler
        });
    }

    getQueue() {
        return this.manager.queue;
    }
}

class PluginHandler {
    constructor(options) {
        options = options || {};

        this.queue = false;

        this.hooks = new Map();
        this.rewriters = new Set();
        this.analyzers = new Set();

        this.pluginsPath = options.pluginsPath || path.join(__dirname, '..', 'plugins');
        this.logger = options.log || log;
        this.loaded = [];

        this.plugins = this.preparePlugins(options.plugins);
    }

    load(done) {
        let curPos = 0;
        let loadNext = () => {
            if (curPos >= this.plugins.length) {
                return done();
            }

            let plugin = this.plugins[curPos++];

            try {
                plugin.module = require(plugin.path); // eslint-disable-line global-require
                plugin.title = plugin.module.title || (path.parse(plugin.path).name || '').replace(/^[a-z]|\-+[a-z]/g, m => m.replace(/[\-]/g, '').toUpperCase());

                if (!plugin.module || typeof plugin.module.init !== 'function') {
                    this.logger.info('Plugins', 'Plugin %s from <%s> does not have an init method', plugin.title, plugin.path);
                    // not much to do here
                    return loadNext();
                }

                return plugin.module.init(new PluginInstance(this, plugin), err => {
                    if (err) {
                        this.logger.error('Plugins', 'Failed loading plugin %s from <%s>: %s', plugin.title, plugin.path, err.message);
                    } else {
                        this.logger.info('Plugins', 'Initialized %s from <%s>', plugin.title, plugin.path);
                        this.loaded.push(plugin);
                    }
                    return loadNext();
                });

            } catch (E) {
                this.logger.error('Plugins', 'Failed loading plugin file <%s>: %s', plugin.path, E.message);
            }

            return loadNext();
        };

        return setImmediate(loadNext);
    }

    preparePlugins(pluginData) {
        return Object.keys(pluginData || {})
            .map(key => {
                if (!key) {
                    return;
                }

                if (!pluginData[key] || (pluginData[key] !== true && !pluginData[key].enabled)) {
                    // disabled
                    return;
                }

                let pluginPath = path.resolve(this.pluginsPath, key);
                let pluginConfig = pluginData[key] !== true ? pluginData[key] : {
                    enabled: true,
                    ordering: Infinity
                };

                return {
                    key,
                    path: pluginPath,
                    ordering: Number(pluginConfig.ordering) || Infinity,
                    config: pluginData[key]
                };
            })
            .filter(plugin => plugin)
            .sort((a, b) => a.ordering - b.ordering);
    }

    addHook(title, name, action) {
        name = (name || '').toString().toLowerCase().trim();
        let hook = {
            title,
            name,
            action
        };
        if (!this.hooks.has(name)) {
            this.hooks.set(name, [hook]);
        } else {
            this.hooks.get(name).push(hook);
        }
    }

    runRewriteHooks(envelope, splitter, output) {
        let input = splitter;

        this.rewriters.forEach(hook => {
            let rewriter = new mailsplit.Rewriter(node => hook.filterFunc(envelope, node));

            rewriter.on('node', data => {
                hook.eventHandler(envelope, data.node, data.decoder, data.encoder);
            });

            input.once('error', err => {
                rewriter.emit('error', err);
            });

            input.pipe(rewriter);

            input = rewriter;
        });

        input.once('error', err => {
            output.emit('error', err);
        });

        input.pipe(output);
    }

    runAnalyzerHooks(envelope, source, output) {
        let input = source;

        this.analyzers.forEach(hook => {
            let analyzer = new PassThrough();
            hook.eventHandler(envelope, input, analyzer);

            input.once('error', err => {
                analyzer.emit('error', err);
            });

            input = analyzer;
        });

        input.once('error', err => {
            output.emit('error', err);
        });

        input.pipe(output);
    }

    runHooks(name, args, done) {
        name = (name || '').toString().toLowerCase().trim();
        let hooks = this.hooks.get(name) || [];
        let pos = 0;
        let checkNext = () => {
            if (pos >= hooks.length) {
                return done();
            }
            let hook = hooks[pos++];
            if (!hook || typeof hook.action !== 'function') {
                return setImmediate(checkNext);
            }
            hook.action(...args, err => {
                if (err) {
                    this.logger.error('Plugins', 'Plugin %s for %s failed with: %s', hook.title, hook.name, err.message);
                    err._source = 'PLUGIN';
                    err._sourceName = hook.title;
                    return done(err);
                }
                setImmediate(checkNext);
            });
        };
        setImmediate(checkNext);
    }
}

module.exports = PluginHandler;
