'use strict';

class FrameParser {
    constructor(socket, handler) {
        this.socket = socket;
        this.handler = handler;

        this.chunks = [];
        this.chunklen = 0;
        this.frame = false;

        this.processing = false;
        this.hasData = false;

        this.socket.on('readable', () => {
            this.hasData = true;
            if (!this.processing) {
                this.read();
            }
        });
    }

    read() {
        this.processing = true;
        let chunk;

        while (this.processing) {
            chunk = this.socket.read();
            if (chunk === null) {
                this.hasData = false;
                this.processing = false;
                return;
            }

            if (!this.frame) {
                if (this.chunklen + chunk.length < 4) {
                    this.chunks.push(chunk);
                    this.chunklen += chunk.length;
                    return setImmediate(() => this.read());
                }
                if (this.chunklen) {
                    this.chunks.push(chunk);
                    this.chunklen += chunk.length;
                    chunk = Buffer.concat(this.chunks, this.chunklen);
                    this.chunks = [];
                    this.chunklen = 0;
                }
                this.frame = chunk.readUInt32LE(0);
                if (chunk.length > 4) {
                    chunk = chunk.slice(4);
                } else {
                    return setImmediate(() => this.read());
                }
            }

            if (this.chunklen + chunk.length < this.frame) {
                this.chunks.push(chunk);
                this.chunklen += chunk.length;
                return setImmediate(() => this.read());
            }

            // we have a full dataframe!
            if (this.chunklen) {
                this.chunks.push(chunk);
                this.chunklen += chunk.length;
                chunk = Buffer.concat(this.chunks, this.chunklen);
                this.chunks = [];
                this.chunklen = 0;
            }

            let frame;
            if (chunk.length === this.frame) {
                frame = chunk;
                chunk = false;
            } else {
                frame = chunk.slice(0, this.frame);
                chunk = chunk.slice(this.frame);
                this.chunks.push(chunk);
                this.chunklen += chunk.length;
            }
            this.frame = false;
            return setImmediate(() => this.processFrame(frame));
        }
    }

    processFrame(frame) {
        this.handler(frame, () => this.read());
    }
}

module.exports = FrameParser;
