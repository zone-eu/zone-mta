'use strict';

const log = require('npmlog');

class ConnectionPool {

    constructor() {
        // the actual connection pool
        this.connectionPool = new Map();

        log.info("ConnPool", "Connection pool is ready to take connections");
    }

    delete(connectionKey) {
        this.connectionPool.delete(connectionKey);
    }

    get(connectionKey) {
        return this.connectionPool.get(connectionKey);
    }

    set(connectionKey, connection) {

        // release the connection, if we don't need it anymore
        let killConnection = (err, connection) => {
            if (!err && typeof connection.quit === 'function') {
                connection.quit();
            }
            if (typeof connection.close === 'function') {
                setImmediate(() => connection.close());
            }
        }

        let killTimer = setTimeout(() => {
            if (connectionPool.has(delivery.connectionKey)) {
                let connList = connectionPool.get(delivery.connectionKey);
                for (let i = 0, len = connList.length; i < len; i++) {
                    if (connList.connection === connection) {
                        connList.splice(i, 1);
                        break;
                    }
                }
                if (!connList.length) {
                    connectionPool.delete(delivery.connectionKey);
                }
            }

            killConnection(null, connection);
        }, connCacheTTL * 1000);
        killTimer.unref();

        let conn = {
            timer: killTimer,
            connection
        };

        this.connectionPool.set(connectionKey, conn);
    }

    has(connectionKey) {
        return this.connectionPool.has(connectionKey);
    }
}

module.exports.ConnectionPool = ConnectionPool;