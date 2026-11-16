'use strict';

const test = require('node:test');
const assert = require('node:assert');

let fs = require('fs');
let { BodyHashStream } = require('mailauth/lib/dkim/body');

test('Calculate body hash byte by byte', (_t, finishTest) => {
    fs.readFile(__dirname + '/fixtures/message1.eml', (err, messageBuf) => {
        assert.ifError(err);

        let sourceMessage = messageBuf.toString('binary').replace(/\r?\n/g, '\r\n');
        let headerSep = sourceMessage.indexOf('\r\n\r\n');
        let message = Buffer.from(sourceMessage.substring(headerSep + 4), 'binary');

        let s = new BodyHashStream('relaxed/relaxed', 'sha256');
        s.on('data', () => true);
        s.on('end', () => true);

        s.on('hash', hash => {
            assert.equal(hash, 'V42It+OeQEd8AxbXHLJW9KkYkv/+fy9B6c33emWfVI4=');
            finishTest();
        });

        let pos = 0;
        let stream = () => {
            if (pos >= message.length) {
                return s.end();
            }
            let ord = Buffer.from([message[pos++]]);
            s.write(ord);

            setImmediate(stream);
        };
        setImmediate(stream);
    });
});

test('Calculate body hash byte all at once', (_t, finishTest) => {
    fs.readFile(__dirname + '/fixtures/message1.eml', (err, messageBuf) => {
        assert.ifError(err);

        let sourceMessage = messageBuf.toString('binary').replace(/\r?\n/g, '\r\n');
        let headerSep = sourceMessage.indexOf('\r\n\r\n');
        let message = Buffer.from(sourceMessage.substring(headerSep + 4), 'binary');

        let s = new BodyHashStream('relaxed/relaxed', 'sha256');
        s.on('data', () => true);
        s.on('end', () => true);

        s.on('hash', hash => {
            assert.equal(hash, 'V42It+OeQEd8AxbXHLJW9KkYkv/+fy9B6c33emWfVI4=');
            finishTest();
        });

        setImmediate(() => s.end(message));
    });
});

test('Calculate body hash for empty message', (_t, finishTest) => {
    let message = Buffer.from('\r\n');

    let s = new BodyHashStream('relaxed/relaxed', 'sha256');
    s.on('data', () => true);
    s.on('end', () => true);

    s.on('hash', hash => {
        assert.equal(hash, '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
        finishTest();
    });

    let pos = 0;
    let stream = () => {
        if (pos >= message.length) {
            return s.end();
        }
        let ord = Buffer.from([message[pos++]]);
        s.write(ord);
        setImmediate(stream);
    };
    setImmediate(stream);
});
