'use strict';

const config = require('config');
const path = require('path');
const log = require('npmlog');
const mailsplit = require('mailsplit');
const duplexer3 = require('duplexer3');

let plugins = {

    hooks: new Map(),
    rewriters: new Set(),

    load(done) {
        let pluginList = Object.keys(config.plugins || {}).map(key => ({
            path: path.resolve(__dirname, '..', 'plugins', (key || '__undefined')),
            ordering: isNaN(config.plugins[key]) || Number(config.plugins[key]) <= 0 ? 0 : Number(config.plugins[key])
        })).filter(plugin => plugin.ordering).sort((a, b) => a.ordering - b.ordering);

        let pos = 0;
        let loadNext = () => {
            if (pos >= pluginList.length) {
                return done();
            }

            let pluginPath = pluginList[pos++].path;

            let plugin;
            try {
                plugin = require(pluginPath); // eslint-disable-line global-require
                if (!plugin || typeof plugin.init !== 'function') {
                    log.info('Plugins', 'Plugin %s from <%s> does not have an init method', plugin.title || '?', pluginPath);
                    // not much to do here
                    return loadNext();
                }
                let title = plugin.title || (path.parse(pluginPath).name || '').replace(/^[a-z]|\-+[a-z]/g, m => m.replace(/[\-]/g, '').toUpperCase());
                plugin.init({
                    addHook: (name, action) => {
                        this.addHook(title, name, action);
                    },
                    addRewriteHook: (filterFunc, eventHandler) => {
                        this.rewriters.add({
                            title,
                            filterFunc,
                            eventHandler
                        });
                    },
                    getQueue: () => this.queue
                }, err => {
                    if (err) {
                        log.error('Plugins', 'Failed loading plugin %s from <%s>: %s', plugin.title || '?', pluginPath, err.message);
                    } else {
                        log.info('Plugins', 'Initialized %s from <%s>', plugin.title || '?', pluginPath);
                    }
                    return loadNext();
                });
            } catch (E) {
                log.error('Plugins', 'Failed loading plugin file <%s>: %s', pluginPath, E.message);
            }

        };

        setImmediate(loadNext);
    },

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
    },

    runRewriteHooks(envelope, splitter, joiner) {
        let input = splitter;

        this.rewriters.forEach(hook => {
            let rewriter = new mailsplit.Rewriter(node => hook.filterFunc(envelope, node));

            rewriter.on('node', data => {
                hook.eventHandler(envelope, data.node, duplexer3(data.encoder, data.decoder));
            });
            input.pipe(rewriter);

            input.on('error', err => {
                rewriter.emit('error', err);
            });

            input = rewriter;
        });

        input.pipe(joiner);
        input.on('error', err => {
            joiner.emit('error', err);
        });
    },

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
                    log.error('Plugins', 'Plugin %s for %s failed with: %s', hook.title, hook.name, err.message);
                    return done(err);
                }
                setImmediate(checkNext);
            });
        };
        setImmediate(checkNext);
    }
};

module.exports = plugins;
