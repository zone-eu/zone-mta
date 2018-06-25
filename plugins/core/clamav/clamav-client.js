'use strict';

const net = require('net');
const Transform = require('stream').Transform;

class ClamStream extends Transform {
    constructor(options) {
        super(options);
        this._started = false;
    }

    _transform(chunk, encoding, done) {
        if (!this._started) {
            this.push('zINSTREAM\x00');
            this._started = true;
        }

        let size = Buffer.allocUnsafe(4);
        size.writeInt32BE(chunk.length, 0);
        this.push(size);
        this.push(chunk);

        done();
    }

    _flush(done) {
        let size = Buffer.allocUnsafe(4);
        size.writeInt32BE(0, 0);
        this.push(size);

        done();
    }
}

module.exports = (port, host, stream, done) => {
    port = port || 3310;
    host = host || '127.0.0.1';

    let socket = new net.Socket();
    let response = '';
    let closeTimer = false;

    let returned = false;
    let callback = (...args) => {
        clearTimeout(closeTimer);
        if (returned) {
            return; // ignore
        }
        returned = true;
        done(...args);
    };

    socket.connect(
        port,
        host,
        () => {
            socket.setTimeout(10 * 1000);
            let client = new ClamStream();
            stream.on('end', () => false);
            stream.on('error', callback);
            stream.pipe(client).pipe(socket);
        }
    );

    socket.on('readable', () => {
        let chunk;

        while ((chunk = socket.read()) !== null) {
            response += chunk.toString();

            if (chunk.toString().indexOf('\x00') >= 0) {
                socket.end();
                let result = response.match(/^stream: (.+) FOUND/);
                if (result !== null) {
                    return callback(null, { clean: false, response: result[1] });
                } else if (response.indexOf('stream: OK') >= 0) {
                    return callback(null, { clean: true });
                } else {
                    result = response.match(/^(.+) ERROR/);
                    if (result !== null) {
                        return callback(new Error(result[1]));
                    } else {
                        return callback(new Error('ERROR response=' + response));
                    }
                }
            }
        }
    });

    socket.on('error', err => {
        try {
            socket.destroy();
        } catch (err) {
            // ignore
        }

        callback(err);
    });

    socket.on('timeout', () => {
        try {
            socket.destroy();
        } catch (err) {
            // ignore
        }

        callback(new Error('Timeout connecting to ClamAV'));
    });

    socket.on('close', () => {
        if (returned) {
            return;
        }
        closeTimer = setTimeout(() => {
            callback(new Error('Unexpected socket close'));
        }, 5000);
    });

    socket.setTimeout(30 * 1000);
};
