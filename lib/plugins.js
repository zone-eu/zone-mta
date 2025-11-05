'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const PluginHandler = require('@zone-eu/wild-plugins');
const db = require('./db');

module.exports.handler = false;

module.exports.init = context => {
    module.exports.handler = new PluginHandler({
        logger: log,
        pluginsPath: config.pluginsPath,
        corePluginsPath: config.corePluginsPath,
        plugins: config.plugins,
        context,
        log: config.log,
        db
    });
};
