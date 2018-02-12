'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const Redis = require('ioredis');
const MongoClient = mongodb.MongoClient;

module.exports.mongoclient = false;

module.exports.database = false;
module.exports.senderDb = false;
module.exports.gridfs = false;
module.exports.users = false;
module.exports.redis = false;
module.exports.redisConfig = false;

let getDBConnection = (main, config, callback) => {
    if (main) {
        if (!config) {
            return callback(null, false);
        }
        if (config && !/[:/]/.test(config)) {
            return callback(null, main.db(config));
        }
    }
    MongoClient.connect(config, (err, db) => {
        if (err) {
            return callback(err);
        }
        if (main && db.s && db.s.options && db.s.options.dbName) {
            db = db.db(db.s.options.dbName);
        }
        return callback(null, db);
    });
};

module.exports.getDBConnection = (config, callback) => {
    getDBConnection(module.exports.mongoclient, config, callback);
};

module.exports.connect = callback => {
    getDBConnection(false, config.dbs.mongo, (err, db) => {
        if (err) {
            return callback(err);
        }
        module.exports.mongoclient = db;

        if (db.s && db.s.options && db.s.options.dbName) {
            module.exports.database = db.db(db.s.options.dbName);
        } else {
            module.exports.database = db;
        }

        getDBConnection(db, config.dbs.gridfs, (err, gdb) => {
            if (err) {
                return callback(err);
            }
            module.exports.gridfs = gdb || module.exports.database;

            getDBConnection(db, config.dbs.users, (err, udb) => {
                if (err) {
                    return callback(err);
                }
                module.exports.users = udb || module.exports.database;

                getDBConnection(db, config.dbs.sender, (err, sdb) => {
                    if (err) {
                        return callback(err);
                    }
                    module.exports.senderDb = sdb || module.exports.database;

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
