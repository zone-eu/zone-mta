'use strict';

const net = require('net');
const Connection = require('./connection');
const EventEmitter = require('events');

class Client extends EventEmitter {
    constructor(options) {
        super();
        this.options = options || {};
        this.connected = false;
        this.socket = false;
        this.client = false;
    }

    connect(next) {
        if (this.socket) {
            return setImmediate(() => next(new Error('Socket already created')));
        }

        this.socket = net.connect(this.options, () => {
            this.connected = true;

            this.client = new Connection(this.socket);

            this.client.once('close', () => {
                this.emit('close');
            });

            this.client.once('error', err => {
                this.emit('error', err);
            });

            this.client.onData = (data, next) => {
                this.onData(data, next);
            };

            next();
        });

        this.socket.once('error', err => {
            if (!this.connected) {
                return next(err);
            }
        });
    }

    send(data) {
        if (!this.connected) {
            return false;
        }
        return this.client.send(data);
    }

    close() {
        if (!this.connected) {
            return false;
        }
        this.client.close();
    }
}

module.exports = Client;

module.exports.createClient = config => {
    let responseHandlers = new Map();
    let remoteClient = new Client(config);
    let cmdId = 0;
    let noopTimer = false;

    // if there is no activity in 15 seconds, then send a NOOP command to keep the connection up
    let scehduleNOOPCall = () => {
        clearTimeout(noopTimer);
        noopTimer = setTimeout(() => {
            remoteClient.send('NOOP');
        }, 15 * 1000);
        noopTimer.unref();
    };

    remoteClient.onData = (data, next) => {
        scehduleNOOPCall();

        let callback;
        if (responseHandlers.has(data.req)) {
            callback = responseHandlers.get(data.req);
            responseHandlers.delete(data.req);
            setImmediate(() => callback(data.error ? data.error : null, !data.error && data.response));
        }
        next();
    };

    remoteClient.sendCommand = (cmd, callback) => {
        scehduleNOOPCall();

        let id = ++cmdId;
        let data = {
            req: id
        };

        if (typeof cmd === 'string') {
            cmd = {
                cmd
            };
        }

        Object.keys(cmd).forEach(key => data[key] = cmd[key]);
        if (typeof callback === 'function') {
            responseHandlers.set(id, callback);
        }

        remoteClient.send(data);
    };

    return remoteClient;
};
