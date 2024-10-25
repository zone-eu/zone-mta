'use strict';

const path = require('path');
const log = require('npmlog');
const mailsplit = require('mailsplit');
const PassThrough = require('stream').PassThrough;
const addressTools = require('./address-tools');
const dgram = require('dgram');
const msgpack = require('msgpack-js');
const Gelf = require('gelf');
const os = require('os');

class PluginInstance {
    constructor(manager, options) {
        this.manager = manager;
        this.options = options || {};
        this.logger = manager.logger;
        this.db = options.db;
        this.config = options.config || {};
        this.mongodb = this.db.senderDb;
        this.redis = this.db.redis;

        this.gelf =
            this.options.log && this.options.log.gelf && this.options.log.gelf.enabled
                ? new Gelf(this.options.log.gelf.options)
                : {
                      // placeholder
                      emit: (ev, entry) => this.logger.info(`Plugins/${process.pid}/GELF`, JSON.stringify(entry))
                  };
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

    addAPI(method, path, callback) {
        this.manager.addAPIEndpoint(this.options.key, method, path, callback);
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
            keys.responseText = responseText.substr(0, 312);
        }

        for (let key of ['interface', 'originhost', 'transhost', 'transtype', 'user']) {
            if (envelope[key] && !(key in keys)) {
                keys[key] = envelope[key];
            }
        }

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
            keys.responseText = responseText.substr(0, 312);
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

    loggelf(message) {
        this.manager.loggelf(message);
    }
}

class PluginHandler {
    constructor(options) {
        options = options || {};
        this.options = options;

        this.queue = false;

        this.hooks = new Map();
        this.rewriters = new Set();
        this.streamers = new Set();
        this.analyzers = new Set();

        this.context = options.context || 'receiver';

        this.corePluginsPath = path.join(__dirname, '..', 'plugins');
        this.pluginsPath = options.pluginsPath || path.join(__dirname, '..', 'plugins');

        this.logger = options.logger || log;

        this.loaded = [];

        this.plugins = this.preparePlugins(options.plugins);

        this.gelf =
            this.options.log && this.options.log.gelf && this.options.log.gelf.enabled
                ? new Gelf(this.options.log.gelf.options)
                : {
                      // placeholder
                      emit: (ev, entry) => this.logger.info(`Plugins/${process.pid}/GELF`, JSON.stringify(entry))
                  };
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
                if (plugin.path.indexOf('/') < 0 && plugin.path.indexOf('\\') < 0) {
                    plugin.path = path.join(process.cwd(), 'node_modules', plugin.path);
                }
                plugin.module = require(plugin.path); // eslint-disable-line global-require
                plugin.title = plugin.module.title || (path.parse(plugin.path).name || '').replace(/^[a-z]|-+[a-z]/g, m => m.replace(/[-]/g, '').toUpperCase());

                if (!plugin.module || typeof plugin.module.init !== 'function') {
                    let loadTime = Date.now() - loadStartTime;
                    this.logger.info(
                        `Plugins/${this.context}/${process.pid}`,
                        'Plugin %s from <%s> does not have an init method [load time %sms]',
                        plugin.title,
                        path.relative(process.cwd(), plugin.path),
                        loadTime
                    );
                    // not much to do here
                    return loadNext();
                }

                let p = new Promise((resolve, reject) => {
                    plugin.db = this.options.db;
                    plugin.logger = this.logger;
                    plugin.log = this.options.log;

                    let f = plugin.module.init(
                        new PluginInstance(this, plugin),
                        // If the handler uses promises then this callback is never called
                        err => {
                            if (err) {
                                return reject(err);
                            }
                            resolve();
                        }
                    );
                    if (f instanceof Promise) {
                        resolve(f);
                    }
                });

                return p
                    .then(() => {
                        let loadTime = Date.now() - loadStartTime;
                        this.logger.info(
                            `Plugins/${this.context}/${process.pid}`,
                            'Initialized %s from <%s> [load time %sms]',
                            plugin.title,
                            path.relative(process.cwd(), plugin.path),
                            loadTime
                        );
                        this.loaded.push(plugin);
                    })
                    .catch(err => {
                        let loadTime = Date.now() - loadStartTime;
                        this.logger.error(
                            `Plugins/${this.context}/${process.pid}`,
                            'Failed loading plugin %s from <%s>: %s [load time %sms]',
                            plugin.title,
                            path.relative(process.cwd(), plugin.path),
                            err.message,
                            loadTime
                        );
                    })
                    .finally(loadNext);
            } catch (E) {
                this.logger.error(
                    `Plugins/${this.context}/${process.pid}`,
                    'Failed loading plugin file <%s>: %s',
                    path.relative(process.cwd(), plugin.path),
                    E.message
                );
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

                    return context.toString().toLowerCase().trim();
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

            rewriter.once('error', err => {
                input.emit('error', err);
            });

            input.pipe(rewriter);

            input = rewriter;
        });

        input.once('error', err => {
            output.emit('error', err);
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

    async runHooksAsync(name, args) {
        name = (name || '').toString().toLowerCase().trim();
        let hooks = this.hooks.get(name) || [];

        for (let hook of hooks) {
            if (!hook || typeof hook.action !== 'function') {
                continue;
            }

            // allow both callbacks and promises as plugin handlers
            let p = new Promise((resolve, reject) => {
                let f = hook.action(
                    ...args,
                    // If the handler uses promises then this callback is never called
                    err => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    }
                );
                if (f instanceof Promise) {
                    resolve(f);
                }
            });

            try {
                await p;
            } catch (err) {
                // non error "errors" are allowed to break the plugin chain, do not log these
                if (/Error$/.test(err.name)) {
                    this.logger.error('Plugins', '"%s" for "%s" failed with: %s', hook.title, hook.name, err.stack);
                }
                err.category = err.category || 'plugin';
                err._source = 'PLUGIN';
                err._sourceName = hook.title;

                throw err;
            }
        }
    }

    runHooks(name, args, done) {
        if (!done) {
            // treat as a promise
            return this.runHooksAsync(name, args);
        }

        // run callback
        this.runHooksAsync(name, args)
            .then(() => done())
            .catch(err => done(err));
    }

    async runHooksWithResponseAsync(name, args) {
        name = (name || '').toString().toLowerCase().trim();
        let hooks = this.hooks.get(name) || [];

        const hookResults = [];

        for (let hook of hooks) {
            if (!hook || typeof hook.action !== 'function') {
                continue;
            }

            // allow both callbacks and promises as plugin handlers
            let p = new Promise((resolve, reject) => {
                let f = hook.action(
                    ...args,
                    // If the handler uses promises then this callback is never called
                    err => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    }
                );
                if (f instanceof Promise) {
                    resolve(f);
                }
            });

            try {
                const result = await p;
                hookResults.push(result);
            } catch (err) {
                // non error "errors" are allowed to break the plugin chain, do not log these
                if (/Error$/.test(err.name)) {
                    this.logger.error('Plugins', '"%s" for "%s" failed with: %s', hook.title, hook.name, err.stack);
                }
                err.category = err.category || 'plugin';
                err._source = 'PLUGIN';
                err._sourceName = hook.title;

                throw err;
            }
        }

        return hookResults;
    }

    runHooksWithResponse (name, args, done) {
        if (!done) {
            // treat as a promise and return the results
            return this.runHooksWithResponseAsync(name, args);
        }
    
        // run with callback and pass the results to done
        this.runHooksWithResponseAsync(name, args)
            .then(results => done(null, results)) // Pass the results array to the callback
            .catch(err => done(err));
    }

    loggelf(message) {
        if (!message) {
            return;
        }

        let gelfOpts = (this.options.log && this.options.log.gelf) || {};

        const component = gelfOpts.component || 'zone-mta';
        const hostname = gelfOpts.hostname || os.hostname();

        if (typeof message === 'string') {
            message = {
                short_message: message
            };
        }

        if (typeof message.short_message !== 'string') {
            message.short_message = (message.short_message || '').toString();
        }

        if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
            message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
        }

        message.facility = component; // facility is deprecated but set by the driver if not provided
        message.host = hostname;
        message.timestamp = Date.now() / 1000;
        message._component = component;

        Object.keys(message).forEach(key => {
            if (!message[key]) {
                delete message[key];
            }
        });

        this.gelf.emit('gelf.log', message);
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

        if (this.options.log && this.options.log.remote) {
            let payload;
            try {
                payload = msgpack.encode(entry);
            } catch (E) {
                log.error('REMOTELOG', '%s Failed encoding message. error="%s"', id + (seq ? '.' + seq : ''), E.message);
            }

            let client = dgram.createSocket(this.options.log.remote.protocol);
            client.send(payload, this.options.log.remote.port, this.options.log.remote.host || 'localhost', () => client.close());
        }

        this.runHooks('log:entry', [entry], () => false);
    }

    addAPIEndpoint(name, method, path, callback) {
        if (this.apiServer && this.apiServer.server) {
            // Missed leading slash ? ... Add it
            if (path.charAt(0) !== '/') {
                path = '/' + path;
            }

            // Check if there is a function with this method name
            let fn = method.toLowerCase();
            let fullPath = '/plugin/' + name + path;
            try {
                if (this.apiServer.server[fn](fullPath, callback)) {
                    this.logger.verbose('Plugins', 'Plugin endpoint %s "%s" successfully registered for "%s"', method, fullPath, name);
                }
            } catch (E) {
                this.logger.error('Plugins', 'Unresolvable API http method "%s" in "%s"', fn, name);
            }
        }
    }
}

module.exports = PluginHandler;
