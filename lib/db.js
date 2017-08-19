'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const redis = require('redis');
const MongoClient = mongodb.MongoClient;

module.exports.database = false;
module.exports.senderDb = false;
module.exports.gridfs = false;
module.exports.users = false;
module.exports.redis = false;
module.exports.redisConfig = false;

let getDBConnection = (main, config, callback) => {
    if (main) {
        if (!config) {
            return callback(null, main);
        }
        if (config && !/[:/]/.test(config)) {
            return callback(null, main.db(config));
        }
    }
    MongoClient.connect(config, (err, db) => {
        if (err) {
            return callback(err);
        }
        return callback(null, db);
    });
};

module.exports.connect = callback => {
    getDBConnection(false, config.dbs.mongo, (err, db) => {
        if (err) {
            return callback(err);
        }
        module.exports.database = db;
        getDBConnection(db, config.dbs.gridfs, (err, db) => {
            if (err) {
                return callback(err);
            }
            module.exports.gridfs = db;
            getDBConnection(db, config.dbs.users, (err, db) => {
                if (err) {
                    return callback(err);
                }
                module.exports.users = db;
                getDBConnection(db, config.dbs.sender, (err, db) => {
                    if (err) {
                        return callback(err);
                    }
                    module.exports.senderDb = db;

                    module.exports.redisConfig = redisConfig(config.dbs.redis);
                    module.exports.redis = redis.createClient(module.exports.redisConfig);

                    return callback(null, module.exports.database);
                });
            });
        });
    });
};

// returns a redis config object with a retry strategy
function redisConfig(defaultConfig) {
    let response = {};

    if (typeof defaultConfig === 'string') {
        defaultConfig = {
            url: defaultConfig
        };
    }

    Object.keys(defaultConfig || {}).forEach(key => {
        response[key] = defaultConfig[key];
    });
    if (!response.hasOwnProperty('retry_strategy')) {
        response.retry_strategy = options => {
            if (options.error && options.error.code === 'ECONNREFUSED') {
                // End reconnecting on a specific error and flush all commands with a individual error
                return new Error('The server refused the connection');
            }

            if (options.total_retry_time > 1000 * 60 * 60) {
                // End reconnecting after a specific timeout and flush all commands with a individual error
                return new Error('Retry time exhausted');
            }

            if (options.attempt > 10) {
                // End reconnecting with built in error
                return undefined; // eslint-disable-line no-undefined
            }

            // reconnect after
            return Math.min(options.attempt * 100, 3000);
        };
    }

    return response;
}
