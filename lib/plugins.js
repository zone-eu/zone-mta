'use strict';

const config = require('config');
const log = require('npmlog');
const PluginHandler = require('./plugin-handler');

module.exports = new PluginHandler({
    logger: log,
    plugins: config.plugins
});
