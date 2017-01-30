'use strict';

const FrameParser = require('./frame-parser');
const EventEmitter = require('events');
const frames = require('./frames');

class Connection extends EventEmitter {
    constructor(socket) {
        super();

        this.socket = socket;

        this.parser = new FrameParser(this.socket, (frame, next) => {
            let data;

            try {
                data = frames.parse(frame);
            } catch (E) {
                this.onError(new Error('Invalid data frame. ' + E.message));
                return this.close();
            }

            this.onData(data, err => {
                if (err) {
                    this.onError(err);
                    return this.close();
                }
                setImmediate(next);
            });
        });

        let onClose = () => {
            if (this._closed) {
                return;
            }

            this._closed = true;
            this._closing = false;
            this.emit('close');
        };

        this.socket.once('close', onClose);
        this.socket.once('end', onClose);

        this.socket.once('error', err => this.onError(err));
        this.parser.once('error', err => {
            this.onError(err);
            return this.close();
        });
    }

    send(data) {
        if (this.closing || this.closed) {
            return false;
        }

        if (this.socket.destroyed) {
            return this.close();
        }

        let chunk = frames.encode(data);
        let response;

        try {
            response = this.socket.write(chunk);
        } catch (E) {
            return this.close();
        }

        return response;
    }

    onError(err) {
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            return this.close();
        }

        this.emit('error', err);
    }

    close() {
        if (this._closed || this._closing) {
            return false;
        }

        if (this.socket && !this.socket.destroyed) {
            try {
                this.socket.end();
            } catch (E) {
                // just ignore
            }
        }

        this._closing = true;
        this.emit('close');
    }
}

module.exports = Connection;
