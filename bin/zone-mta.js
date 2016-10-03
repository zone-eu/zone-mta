#!/usr/bin/env node

/* eslint no-unused-expressions: 0, global-require: 0, no-console: 0 */
'use strict';

const yargs = require('yargs');
const path = require('path');
const mkdirp = require('mkdirp');
const fs = require('fs');

yargs.usage('$0 <cmd> [args]').
command('run', 'Run ZoneMTA application', {
    'config-file': {
        default: '',
        alias: 'c',
        describe: 'Path to configuration file',
        type: 'string'
    },
    directory: {
        default: process.cwd(),
        alias: 'd',
        describe: 'Application directory',
        type: 'string'
    }
}, argv => {
    let directory = argv.directory.charAt(0) === '/' ? argv.directory : path.join(process.cwd(), argv.directory);

    //process.env.NODE_ENV = 'production';
    process.env.SUPPRESS_NO_CONFIG_WARNING = 'yes';
    process.env.NODE_CONFIG_DIR = path.join(__dirname, '..', 'config');
    let customConfig;
    let customPluginPath;
    if (argv.configFile) {
        try {
            customConfig = require(argv.configFile.charAt(0) === '/' ? argv.configFile : path.join(directory, argv.configFile));
            customPluginPath = customConfig.pluginPath;
            process.env.NODE_CONFIG = JSON.stringify(customConfig);
        } catch (E) {
            console.error(E);
            return process.exit(1);
        }
    }
    let config = require('config');
    config.pluginPath = customPluginPath || path.join(directory, 'plugins');

    require('../app');
}).
command('create [directory]', 'Create new ZoneMTA application', {
    directory: {
        default: '.',
        describe: 'Path to application directory',
        type: 'string'
    }
}, argv => {
    let directory = argv.directory.charAt(0) === '/' ? argv.directory : path.join(process.cwd(), argv.directory);
    mkdirp(directory, err => {
        if (err) {
            console.error(err);
            return process.exit(1);
        }

        mkdirp(path.join(directory, 'plugins'), err => {
            if (err) {
                console.error(err);
                return process.exit(1);
            }

            mkdirp(path.join(directory, 'data', 'queue'), err => {
                if (err) {
                    console.error(err);
                    return process.exit(1);
                }

                // default config object
                let config = {
                    log: {
                        syslog: false,
                        level: 'info'
                    },
                    queue: {
                        db: './data/queue'
                    },
                    smtpInterfaces: {
                        feeder: {
                            enabled: true,
                            port: 2525
                        }
                    },
                    pluginsPath: './plugins',
                    plugins: {
                        'core/default-headers': {
                            enabled: ['main', 'sender'],
                            futureDate: false,
                            xOriginatingIP: true
                        }
                    }
                };

                fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config, false, 2), err => {
                    if (err) {
                        console.error(err);
                        return process.exit(1);
                    }

                    console.log('Application created at <%s>, run the following command to start the server:', directory);
                    console.log('  %s run -d %s -c %s', argv.$0, path.relative(process.cwd(), directory), 'config.json');
                });

            });
        });
    });
}).

help().
argv;
