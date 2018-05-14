'use strict';

const path = require('path');
const log = require('npmlog');
const mailsplit = require('mailsplit');
const PassThrough = require('stream').PassThrough;
const addressTools = require('./address-tools');
const db = require('./db');
const config = require('wild-config');
const dgram = require('dgram');
const msgpack = require('msgpack-js');

class PluginInstance {
    constructor(manager, options) {
        this.manager = manager;
        this.options = options || {};
        this.config = options.config || {};
        this.logger = manager.logger;
        this.db = db;
        this.mongodb = db.senderDb;
        this.redis = db.redis;
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

    addStreamHook(filterFunc, eventHandler) {
        this.manager.streamers.add({
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

    validateAddress(headers, key) {
        return addressTools.validateAddress(headers, key);
    }

    drop(envelope, description, messageInfo, responseText) {
        let id;

        if (typeof envelope === 'object') {
            id = envelope.id;
        } else {
            id = envelope;
            envelope = {};
        }

        description = (description || '').toString().trim();
        let keys;
        if (messageInfo && typeof messageInfo.keys === 'function') {
            keys = messageInfo.keys();
        } else {
            keys = {};
        }
        if (messageInfo && typeof messageInfo.format === 'function') {
            messageInfo = messageInfo.format();
        }
        messageInfo = (messageInfo || '').toString().trim();
        responseText = (responseText || '').toString();

        if (description) {
            keys.description = description;
        }

        if (responseText) {
            keys.responseText = responseText.substr(0, 192);
        }

        ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
            if (envelope[key] && !(key in keys)) {
                keys[key] = envelope[key];
            }
        });

        this.manager.remotelog(id, false, 'DROP', keys);

        let msg = '%s DROP' + (description ? '[' + description + ']' : '') + (messageInfo ? ' (' + messageInfo + ')' : '');
        this.logger.info(this.options.title, msg, id);

        responseText = responseText.replace(/^\d{3}\s+/, '');

        let err = new Error(responseText || 'Message queued as ' + id);
        err.name = 'SMTPResponse';
        return err;
    }

    reject(envelope, description, messageInfo, responseText) {
        let id;

        if (typeof envelope === 'object') {
            id = envelope.id;
        } else {
            id = envelope;
            envelope = {};
        }

        description = (description || '').toString().trim();
        let keys;
        if (messageInfo && typeof messageInfo.keys === 'function') {
            keys = messageInfo.keys();
        } else {
            keys = {};
        }

        if (messageInfo && typeof messageInfo.format === 'function') {
            messageInfo = messageInfo.format();
        }
        messageInfo = (messageInfo || '').toString().trim();
        responseText = (responseText || '').toString();

        if (description) {
            keys.description = description;
        }

        if (responseText) {
            keys.responseText = responseText.substr(0, 192);
        }

        ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
            if (envelope[key] && !(key in keys)) {
                keys[key] = envelope[key];
            }
        });

        this.manager.remotelog(id, false, 'NOQUEUE', keys);

        let msg = '%s NOQUEUE' + (description ? '[' + description + ']' : '') + (messageInfo ? ' (' + messageInfo + ')' : '');
        this.logger.info(this.options.title, msg, id);

        let code;
        responseText = responseText.replace(/^(\d{3})\s+/, (str, c) => {
            code = Number(c);
            return '';
        });

        let err = new Error(responseText);
        err.name = 'SMTPReject';
        err.responseCode = code || 550;

        return err;
    }

    remotelog(id, seq, action, data) {
        this.manager.remotelog(id, seq, action, data);
    }
}

class PluginHandler {
    constructor(options) {
        options = options || {};

        this.queue = false;

        this.hooks = new Map();
        this.rewriters = new Set();
        this.streamers = new Set();
        this.analyzers = new Set();

        this.context = options.context || 'receiver';

        this.corePluginsPath = path.join(__dirname, '..', 'plugins');
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
                let loadStartTime = Date.now();
                if (plugin.path.indexOf('/') < 0) {
                    plugin.path = path.join(process.cwd(), 'node_modules', plugin.path);
                }
                plugin.module = require(plugin.path); // eslint-disable-line global-require
                plugin.title = plugin.module.title || (path.parse(plugin.path).name || '').replace(/^[a-z]|-+[a-z]/g, m => m.replace(/[-]/g, '').toUpperCase());

                if (!plugin.module || typeof plugin.module.init !== 'function') {
                    let loadTime = Date.now() - loadStartTime;
                    this.logger.info(
                        'Plugins',
                        'Plugin %s from <%s> does not have an init method [load time %sms]',
                        plugin.title,
                        path.relative(process.cwd(), plugin.path),
                        loadTime
                    );
                    // not much to do here
                    return loadNext();
                }

                return plugin.module.init(new PluginInstance(this, plugin), err => {
                    let loadTime = Date.now() - loadStartTime;
                    if (err) {
                        this.logger.error(
                            'Plugins',
                            'Failed loading plugin %s from <%s>: %s [load time %sms]',
                            plugin.title,
                            path.relative(process.cwd(), plugin.path),
                            err.message,
                            loadTime
                        );
                    } else {
                        this.logger.verbose(
                            'Plugins',
                            'Initialized %s from <%s> [load time %sms]',
                            plugin.title,
                            path.relative(process.cwd(), plugin.path),
                            loadTime
                        );
                        this.loaded.push(plugin);
                    }
                    return loadNext();
                });
            } catch (E) {
                this.logger.error('Plugins', 'Failed loading plugin file <%s>: %s', path.relative(process.cwd(), plugin.path), E.message);
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

                let pluginPath;
                if (/^[./]*modules\//.test(key)) {
                    pluginPath = key.replace(/^[./]*modules\//, '');
                } else {
                    pluginPath = path.resolve(/^[./]*core\//.test(key) ? this.corePluginsPath : this.pluginsPath, key);
                }

                let pluginConfig =
                    pluginData[key] !== true
                        ? pluginData[key]
                        : {
                              enabled: true,
                              ordering: Infinity
                          };

                // Only load plugins with correct context. If context is not set then default to "main"
                let allowedContext = [].concat(pluginConfig.enabled || 'receiver').map(context => {
                    if (context === true) {
                        return '*';
                    }

                    if (typeof context !== 'string') {
                        return 'receiver';
                    }

                    return context
                        .toString()
                        .toLowerCase()
                        .trim();
                });

                if (!allowedContext.includes(this.context) && !allowedContext.includes('*')) {
                    return;
                }

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
        name = (name || '')
            .toString()
            .toLowerCase()
            .trim();
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

            rewriter.once('error', err => {
                input.emit('error', err);
            });

            input.pipe(rewriter);

            input = rewriter;
        });

        output.once('error', err => {
            input.emit('error', err);
        });

        input.pipe(output);
    }

    runStreamHooks(envelope, splitter, output) {
        let input = splitter;
        this.streamers.forEach(hook => {
            let streamer = new mailsplit.Streamer(node => hook.filterFunc(envelope, node));
            let stream = input;

            streamer.on('node', data => {
                hook.eventHandler(envelope, data.node, data.decoder, data.done);
            });

            stream.once('error', err => {
                streamer.emit('error', err);
            });

            stream.pipe(streamer);

            input = streamer;
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
            let stream = input;
            hook.eventHandler(envelope, stream, analyzer);

            stream.once('error', err => {
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
        name = (name || '')
            .toString()
            .toLowerCase()
            .trim();
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
                    // non error "errors" are allowed to break the plugin chain, do not log these
                    if (/Error$/.test(err.name)) {
                        this.logger.error('Plugins', '"%s" for "%s" failed with: %s', hook.title, hook.name, err.message);
                    }
                    err.category = err.category || 'plugin';
                    err._source = 'PLUGIN';
                    err._sourceName = hook.title;
                    return done(err);
                }
                setImmediate(checkNext);
            });
        };
        setImmediate(checkNext);
    }

    remotelog(id, seq, action, data) {
        let entry = {
            id
        };
        if (seq) {
            entry.seq = seq;
        }
        if (action) {
            entry.action = action;
        }
        if (data) {
            Object.keys(data).forEach(key => {
                if (!(key in entry)) {
                    entry[key] = data[key];
                }
            });
        }

        if (config.log.remote) {
            let payload;
            try {
                payload = msgpack.encode(entry);
            } catch (E) {
                log.error('REMOTELOG', '%s Failed encoding message. error="%s"', id + (seq ? '.' + seq : ''), E.message);
            }

            let client = dgram.createSocket(config.log.remote.protocol);
            client.send(payload, config.log.remote.port, config.log.remote.host || 'localhost', () => client.close());
        }

        this.runHooks('log:entry', [entry], () => false);
    }
}

module.exports = PluginHandler;
