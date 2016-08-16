'use strict';

const net = require('net');
const Connection = require('./connection');
const EventEmitter = require('events');

class Server extends EventEmitter {
    constructor(options) {
        super(options);

        this.clients = new Set();

        this.server = net.createServer(socket => {
            let client = new Connection(socket);
            this.clients.add(client);
            client.on('close', () => {
                this.clients.delete(client);
            });
            client.on('error', () => {
                this.clients.delete(client);
            });
            this.emit('client', client);
        });

        this.server.on('error', err => {
            this.emit('error', err);
        });
    }

    listen() {
        this.server.listen(...arguments);
    }

    close(next) {
        this.clients.forEach(client => {
            client.send({
                cmd: 'close'
            });
            client.close();
        });
        this.server.close(next);
    }
}

module.exports = Server;
