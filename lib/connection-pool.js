'use strict';

const log = require('npmlog');

class ConnectionPool {

    constructor(sendCommand) {
        // the actual connection pool
        this.connectionPool = new Map();

        this.sendCommand = sendCommand;

        log.info("ConnPool/"+process.pid, "Connection pool is ready to take connections");
    }

    delete(connectionKey) {
        this.connectionPool.delete(connectionKey);
    }

    getConnection(connectionKey) {
        let connList = this.connectionPool.get(connectionKey);

        if (connList.length) {
            let conn = connList.shift();

            // Connection list is empty, remove it from pool
            if (!connList.size) {
                this.connectionPool.delete(connectionKey);
            }
            clearTimeout(conn.timer); // prevent closing of socket
            if (conn.connection && conn.connection.connected && !conn.connection._closing && !conn.connection._destroyed) {
                // connection seems to be still open
                conn.connection.logtrail = []; // reset logtrail

                // send statistics to queue server in master process
                this.sendCommand({ cmd: 'COUNTMETRICS', metric: 'connPoolSizeGauge', func: 'dec' }, () => false);
                this.sendCommand({ cmd: 'COUNTMETRICS', metric: 'connReuseCounter', func: 'inc' }, () => false);

                return conn;
            }
        }
        return null;
    }

    killConnection(err, connection) {
        if (!err && typeof connection.quit === 'function') {
            connection.quit();
        }
        if (typeof connection.close === 'function') {
            setImmediate(() => connection.close());
        }
    }

    add(connectionKey, connection, ttl) {

        let killTimer = setTimeout(() => {
            if (this.has(connectionKey)) {
                let connList = this.connectionPool.get(connectionKey);
                for (let i = 0, len = connList.length; i < len; i++) {
                    if (connList[i].connection === connection) {
                        connList.splice(i, 1);
                        break;
                    }
                }
                if (!connList.length) {
                    this.connectionPool.delete(connectionKey);
                }
            }

            this.sendCommand({ cmd: 'COUNTMETRICS', metric: 'connPoolSizeGauge', func: 'dec' }, () => false);
            this.killConnection(null, connection);
        }, ttl * 1000);
        killTimer.unref();

        let conn = {
            timer: killTimer,
            connection
        };

        log.verbose("ConnPool/"+process.pid, "Pooling connection for '"+connectionKey+"'");
        this.sendCommand({ cmd: 'COUNTMETRICS', metric: 'connPoolSizeGauge', func: 'inc' }, () => false);
        if (this.has(connectionKey)) {
            // already cached connections found, appending new connection
            this.connectionPool.get(connectionKey).push(conn);
        } else {
            // no connections found, caching it
            this.connectionPool.set(connectionKey, [conn]);
        }
    }

    has(connectionKey) {
        return this.connectionPool.has(connectionKey);
    }
}

module.exports = ConnectionPool;
