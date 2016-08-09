'use strict';

let fs = require('fs');
let DkimRelaxedBody = require('../lib/dkim-relaxed-body');

module.exports['Calculate body hash byte by byte'] = test => {
    fs.readFile(__dirname + '/fixtures/message1.eml', 'utf-8', (err, message) => {
        test.ifError(err);

        message = message.replace(/\r?\n/g, '\r\n');
        message = message.split('\r\n\r\n');
        message.shift();
        message = message.join('\r\n\r\n');

        message = Buffer.from(message);

        let s = new DkimRelaxedBody({
            hash: 'sha256',
            debug: true
        });

        s.on('hash', hash => {
            test.equal(hash, 'BPn9yHxMRt2aqIXVxv9wDcV0TlsNua+PdNYnNyAIMLY=');
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
    fs.readFile(__dirname + '/fixtures/message1.eml', 'utf-8', (err, message) => {
        test.ifError(err);

        message = message.replace(/\r?\n/g, '\r\n');
        message = message.split('\r\n\r\n');
        message.shift();
        message = message.join('\r\n\r\n');

        message = Buffer.from(message);

        let s = new DkimRelaxedBody({
            hash: 'sha256',
            debug: true
        });

        s.on('hash', hash => {
            test.equal(hash, 'BPn9yHxMRt2aqIXVxv9wDcV0TlsNua+PdNYnNyAIMLY=');
            test.done();
        });

        setImmediate(() => s.end(message));
    });

};
