/* eslint global-require:0 */
'use strict';

const config = require('wild-config');
const dns = require('dns');
const log = require('npmlog');
const db = require('./db');

const nameservers = [].concat(config.nameservers || []);

const logKey = `DNS/${process.pid}`;
const CACHE_GET_MAX_WAIT = 500; // how much time to wait for the cache to respond

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

        log.silly(logKey, 'DNSCACHE SET key=%s value=%s', key, JSON.stringify(value));

        db.redis
            .multi()
            .set('dns:' + key, JSON.stringify(value))
            .expire('dns:' + key, this.ttl)
            .exec((...args) => {
                if (args[0]) {
                    // err
                    log.error(logKey, 'DNSREDISERR SET key=%s error=%s', key, args[0].message);
                }
                callback(...args);
            });
    }

    get(key, callback) {
        if (!db.redis) {
            return callback();
        }

        let finished = false;
        let waitUntil = setTimeout(() => {
            if (finished) {
                return;
            }
            finished = true;
            return callback();
        }, CACHE_GET_MAX_WAIT);

        db.redis.get('dns:' + key, (err, value) => {
            clearTimeout(waitUntil);
            if (finished) {
                return;
            }
            finished = true;

            if (err) {
                log.error(logKey, 'DNSREDISERR GET key=%s error=%s', key, err.message);
                // treat errors as a MISS
                return callback();
            }

            if (!value) {
                log.silly(logKey, 'DNSCACHEMISS key=%s', key);
                return callback();
            }
            try {
                value = JSON.parse(value);
            } catch (E) {
                return callback();
            }

            log.silly(logKey, 'DNSCACHEHIT key=%s', key);
            callback(null, value);
        });
    }
}

// use caching
if (config.dns.caching) {
    // setup DNS caching
    require('dnscache')({
        enable: true,
        ttl: config.dns.cacheTTL,
        cachesize: 1000,
        cache: RedisCache
    });
    log.info(logKey, 'Loaded DNS cache');
}
