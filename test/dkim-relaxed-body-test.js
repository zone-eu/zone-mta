'use strict';

let fs = require('fs');
let { BodyHashStream } = require('mailauth/lib/dkim/body');

module.exports['Calculate body hash byte by byte'] = test => {
    fs.readFile(__dirname + '/fixtures/message1.eml', (err, messageBuf) => {
        test.ifError(err);

        let sourceMessage = messageBuf.toString('binary').replace(/\r?\n/g, '\r\n');
        let headerSep = sourceMessage.indexOf('\r\n\r\n');
        let message = Buffer.from(sourceMessage.substring(headerSep + 4), 'binary');

        let s = new BodyHashStream('relaxed/relaxed', 'sha256');
        s.on('data', () => true);
        s.on('end', () => true);

        s.on('hash', hash => {
            test.equal(hash, 'V42It+OeQEd8AxbXHLJW9KkYkv/+fy9B6c33emWfVI4=');
            test.done();
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
};

module.exports['Calculate body hash byte all at once'] = test => {
    fs.readFile(__dirname + '/fixtures/message1.eml', (err, messageBuf) => {
        test.ifError(err);

        let sourceMessage = messageBuf.toString('binary').replace(/\r?\n/g, '\r\n');
        let headerSep = sourceMessage.indexOf('\r\n\r\n');
        let message = Buffer.from(sourceMessage.substring(headerSep + 4), 'binary');

        let s = new BodyHashStream('relaxed/relaxed', 'sha256');
        s.on('data', () => true);
        s.on('end', () => true);

        s.on('hash', hash => {
            test.equal(hash, 'V42It+OeQEd8AxbXHLJW9KkYkv/+fy9B6c33emWfVI4=');
            test.done();
        });

        setImmediate(() => s.end(message));
    });
};

module.exports['Calculate body hash for empty message'] = test => {
    let message = Buffer.from('\r\n');

    let s = new BodyHashStream('relaxed/relaxed', 'sha256');
    s.on('data', () => true);
    s.on('end', () => true);

    s.on('hash', hash => {
        test.equal(hash, '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
        test.done();
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
};
