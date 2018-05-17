/* eslint global-require:0 */
'use strict';

const config = require('wild-config');
const dns = require('dns');
const log = require('npmlog');
const db = require('./db');

const nameservers = [].concat(config.nameservers || []);

// set the nameservers to use for resolving

if (nameservers.length) {
    dns.setServers(nameservers);
}

class RedisCache {
    constructor(conf) {
        conf = conf || {};
        this.ttl = parseInt(conf.ttl, 10) || 300; //0 is not permissible
    }

    set(key, value, callback) {
        if (typeof value === 'undefined') {
            return callback();
        }
        if (!db.redis) {
            return callback();
        }
        db.redis
            .multi()
            .set('dns:' + key, JSON.stringify(value))
            .expire('dns:' + key, this.ttl)
            .exec((...args) => {
                if (args[0]) {
                    // err
                    log.error('DNS', 'DNSREDISERR SET key=%s error=%s', key, args[0].message);
                }
                callback(...args);
            });
    }

    get(key, callback) {
        if (!db.redis) {
            return callback();
        }
        db.redis.get('dns:' + key, (err, value) => {
            if (err) {
                log.error('DNS', 'DNSREDISERR GET key=%s error=%s', key, err.message);
                return callback(err);
            }

            if (!value) {
                log.silly('DNS', 'DNSCACHEMISS key=%s', key);
                return callback();
            }
            try {
                value = JSON.parse(value);
            } catch (E) {
                return callback();
            }

            log.silly('DNS', 'DNSCACHEHIT key=%s', key);
            callback(null, value);
        });
    }
}

// use caching
if (config.dns.caching) {
    // setup DNS caching
    require('dnscache')({
        enable: true,
        ttl: config.dns.cahceTTL,
        cachesize: 1000,
        cache: RedisCache
    });
}
