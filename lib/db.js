'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const Redis = require('ioredis');
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
                    module.exports.redis = new Redis(module.exports.redisConfig);

                    return callback(null, module.exports.database);
                });
            });
        });
    });
};

// returns a redis config object with a retry strategy
function redisConfig(defaultConfig) {
    return defaultConfig;
}
