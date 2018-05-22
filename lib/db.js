'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const Redis = require('ioredis');
const log = require('npmlog');
const MongoClient = mongodb.MongoClient;

module.exports.mongoclient = false;

module.exports.database = false;
module.exports.senderDb = false;
module.exports.gridfs = false;
module.exports.users = false;

module.exports.redisConfig = redisConfig(config.dbs.redis);
module.exports.redis = false;

let getRedisConnection = callback => {
    let redisReturned = false;
    let redis = new Redis(module.exports.redisConfig);
    redis.on('error', err => {
        if (!redisReturned) {
            redisReturned = true;
            return callback(err);
        }
        log.error('Redis/' + process.pid, '%s', err.message);
    });
    redis.once('ready', () => {
        module.exports.redis = redis;
        if (!redisReturned) {
            redisReturned = true;
            return callback(null, true);
        }
        log.info('Redis/' + process.pid, 'Redis ready to take connections');
    });
};

let getDBConnection = (main, config, callback) => {
    if (main) {
        if (!config) {
            return callback(null, false);
        }
        if (config && !/[:/]/.test(config)) {
            return callback(null, main.db(config));
        }
    }
    MongoClient.connect(
        config,
        {
            useNewUrlParser: true,
            reconnectTries: 100000,
            reconnectInterval: 1000
        },
        (err, db) => {
            if (err) {
                return callback(err);
            }
            if (main && db.s && db.s.options && db.s.options.dbName) {
                db = db.db(db.s.options.dbName);
            }
            return callback(null, db);
        }
    );
};

module.exports.getDBConnection = (config, callback) => {
    getDBConnection(module.exports.mongoclient, config, callback);
};

module.exports.connect = callback => {
    getRedisConnection(err => {
        if (err) {
            return callback(err);
        }

        if (module.exports.database) {
            // already connected
            return callback(null, module.exports.database);
        }

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

                        return callback(null, module.exports.database);
                    });
                });
            });
        });
    });
};

// returns a redis config object with a retry strategy
function redisConfig(defaultConfig) {
    return defaultConfig;
}
