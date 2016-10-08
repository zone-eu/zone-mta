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
