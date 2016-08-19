'use strict';

// We use 4-bytes unsigned integers so we waste the fourth byte when limiting
// max frame size number in megabytes. The good thing is that we can increase the
// frame size in the future if needed
const MAX_ALLOWED_FRAME_SIZE = 2 * 1024 * 1024; // 2MB

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

        // enough data already piled up
        if (!this.frame && this.chunklen >= 4) {
            chunk = Buffer.concat(this.chunks, this.chunklen);
            console.log('DATAFRAME 0 ', chunk.toString());
            this.chunks = [];
            this.chunklen = 0;
        } else {
            chunk = this.socket.read();
            console.log('READ FROM SOCKET %s', chunk ? chunk.toString() : chunk);
        }

        console.log(this.frame, this.chunklen);
        if (chunk === null) {
            this.hasData = false;
            this.processing = false;
            // all done
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

            if (this.frame > MAX_ALLOWED_FRAME_SIZE) {
                return this.socket.end('Invalid Frame Size');
            }
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
            console.log('DATAFRAME 1 ', chunk.toString());
            this.chunks = [];
            this.chunklen = 0;
        }

        return this.getFrame(chunk);
    }

    getFrame(chunk) {
        let frame;
        if (chunk.length === this.frame) {
            frame = chunk;
            console.log('DATAFRAME 2 ', frame.toString());
            chunk = false;
        } else {
            frame = chunk.slice(0, this.frame);
            chunk = chunk.slice(this.frame);
            this.chunks.push(chunk);
            console.log('DATAFRAME 3 ', frame.toString());
            console.log('DATAFRAME 4 ', chunk.toString());
            this.chunklen += chunk.length;
        }
        this.frame = false;
        return setImmediate(() => this.processFrame(frame));
    }

    processFrame(frame) {
        this.id = this.id || 0;
        this.id++;
        let y = this.id;
        console.log('EXPECTING RESPONSE FOR %s', y);
        this.handler(frame, () => {
            console.log('RECEIVED RESPONSE FOR %s', y);
            this.read();
        });
    }
}

module.exports = FrameParser;
