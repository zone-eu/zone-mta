'use strict';

const config = require('wild-config');
const log = require('npmlog');
const PluginHandler = require('./plugin-handler');

module.exports.handler = false;

module.exports.init = context => {
    module.exports.handler = new PluginHandler({
        logger: log,
        pluginsPath: config.pluginsPath,
        plugins: config.plugins,
        context
    });
};
