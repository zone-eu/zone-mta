#!/usr/bin/env node

/* eslint no-unused-expressions: 0, global-require: 0, no-console: 0 */
'use strict';

const yargs = require('yargs');
const path = require('path');
const mkdirp = require('mkdirp');
const fs = require('fs');

let showhelp = true;

yargs.usage('$0 <cmd> [args]').
command('run', 'Run ZoneMTA application', {
    'config-file': {
        default: 'config.json',
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
    showhelp = false;
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
            console.log(E.message);
            yargs.showHelp();
            return process.exit(1);
        }
    }
    let config = require('config');
    config.pluginsPath = customPluginPath || path.join(directory, 'plugins');

    require('../app');
}).
command('create [directory]', 'Create new ZoneMTA application', {
    directory: {
        default: '.',
        describe: 'Path to application directory',
        type: 'string'
    }
}, argv => {
    showhelp = false;
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

                let examplePlugin = `'use strict';

// This is an exmaple plugin that is disabled by default. To enable it,
// see the "plugins"."example" option in config.json

// Set module title
module.exports.title = 'ExamplePlugin';

// Initialize the module
module.exports.init = (app, done) => {

    // register a new hook that fires when message headers have been parsed
    app.addHook('message:headers', (envelope, messageInfo, next) => {

        // Check if the message has header "X-Block-Message: Yes"
        if (/^Yes$/i.test(envelope.headers.getFirst('X-Block-Message'))) {
            let err = new Error('This message was blocked');
            err.responseCode = 500; // SMTP response code
            return next(err);
        }

        // add a new header
        envelope.headers.add('X-Blocked', 'no');

        // allow the message to pass
        return next();
    });

    // all set up regarding this plugin
    done();
};
`;

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
                            enabled: ['receiver', 'sender'],
                            futureDate: false,
                            xOriginatingIP: true
                        },
                        example: false
                    }
                };

                fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config, false, 2), err => {
                    if (err) {
                        console.error(err);
                        return process.exit(1);
                    }

                    fs.writeFile(path.join(directory, 'plugins', 'example.js'), examplePlugin, err => {
                        if (err) {
                            console.error(err);
                            return process.exit(1);
                        }

                        console.log('Application created at <%s>, run the following command to start the server:', directory);
                        console.log('  %s run -d %s', argv.$0, path.relative(process.cwd(), directory));
                    });
                });

            });
        });
    });
}).

help().
argv;

if (showhelp) {
    yargs.showHelp();
}
