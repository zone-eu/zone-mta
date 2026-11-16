'use strict';

const test = require('node:test');
const assert = require('node:assert');

const log = require('npmlog');
const PluginHandler = require('@zone-eu/wild-plugins');
const plugins = require('../lib/plugins');
const MailDrop = require('../lib/mail-drop');
const SizeLimiter = require('../lib/size-limiter');
const PassThrough = require('stream').PassThrough;

// More MIME nodes than mailsplit allows by default (1000), followed by a large part so that the
// message does not fit into the stream buffers
function buildMessage() {
    let lines = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: many parts',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        ''
    ];
    for (let i = 0; i < 1100; i++) {
        lines.push('--BOUNDARY', 'Content-Type: text/plain', '', 'part ' + i);
    }
    let filler = Buffer.alloc(3 * 1024 * 1024, 'a').toString('base64').replace(/.{76}/g, '$&\r\n');
    lines.push('--BOUNDARY', 'Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64', '', filler, '--BOUNDARY--', '');
    return Buffer.from(lines.join('\r\n'));
}

function createQueue() {
    return {
        store(id, stream, callback) {
            stream.on('data', () => false);
            stream.once('error', err => callback(err));
            stream.once('end', () => callback(null, id));
        },
        removeMessage(id, callback) {
            setImmediate(callback);
        },
        setMeta(id, envelope, callback) {
            setImmediate(callback);
        }
    };
}

// Feeds the message the way smtp-server does: honours backpressure and needs the stream to be
// consumed to the end before the client is answered
function runDrop(analyzers, maxSize, failLater, done) {
    let originalHandler = plugins.handler;
    let originalLevel = log.level;
    log.level = 'silent';

    let pluginConfig = {};
    analyzers.forEach(name => {
        pluginConfig[name] = true;
    });
    let handler = new PluginHandler({
        pluginsPath: __dirname + '/plugins',
        plugins: pluginConfig,
        db: {},
        log: {}
    });

    handler.load(() => {
        plugins.handler = handler;

        let result = { thrown: false };
        let timer = null;
        let finished = false;

        let onException = err => {
            result.thrown = err;
            finish(); // eslint-disable-line no-use-before-define
        };

        let finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            process.removeListener('uncaughtException', onException);
            plugins.handler = originalHandler;
            log.level = originalLevel;
            done(result);
        };

        process.on('uncaughtException', onException);
        timer = setTimeout(() => {
            result.stalled = true;
            finish();
        }, 5000);

        // wired like SMTPInterface#handleMessage
        let stream = new PassThrough();
        let sizeLimiter = new SizeLimiter({ maxSize });
        stream.on('error', err => sizeLimiter.emit('error', err));
        stream.pipe(sizeLimiter);

        new MailDrop(createQueue()).add({ id: 'test', from: 'sender@example.com', to: ['recipient@example.com'] }, sizeLimiter, err => {
            result.err = err;
        });

        let message = buildMessage();
        let pos = 0;
        // one chunk per tick, as if read from a socket
        let write = () => {
            if (pos >= message.length) {
                return stream.end();
            }
            let chunk = message.subarray(pos, pos + 64 * 1024);
            pos += chunk.length;
            if (!stream.write(chunk)) {
                return stream.once('drain', write);
            }
            setImmediate(write);
        };
        // smtp-server waits for the end of the data stream before it answers the client
        stream.on('end', () => {
            if (failLater) {
                // eg. an analyzer that gives up on the message after the store has failed
                sizeLimiter.emit('error', new Error('Analyzer failed'));
            }
            setTimeout(finish, 100);
        });
        write();
    });
}

test('Message over the MIME node limit is drained without analyzers', (_t, finishTest) => {
    runDrop([], 30 * 1024 * 1024, false, result => {
        assert.ok(!result.stalled, 'message stream was not consumed to the end');
        assert.ok(!result.thrown, 'uncaught exception: ' + result.thrown);
        assert.equal(result.err && result.err.code, 'EMAXLEN');
        finishTest();
    });
});

test('Message over the MIME node limit is drained with a readable analyzer', (_t, finishTest) => {
    runDrop(['analyzer-readable'], 30 * 1024 * 1024, false, result => {
        assert.ok(!result.stalled, 'message stream was not consumed to the end');
        assert.ok(!result.thrown, 'uncaught exception: ' + result.thrown);
        assert.equal(result.err && result.err.code, 'EMAXLEN');
        finishTest();
    });
});

test('Message over the MIME node limit and the size limit does not throw', (_t, finishTest) => {
    // the size limiter fails as well, so the splitter gets a second error
    runDrop([], 1024 * 1024, false, result => {
        assert.ok(!result.stalled, 'message stream was not consumed to the end');
        assert.ok(!result.thrown, 'uncaught exception: ' + result.thrown);
        assert.ok(result.err);
        finishTest();
    });
});

test('Error emitted after the MIME node limit does not throw', (_t, finishTest) => {
    runDrop(['analyzer-readable'], 30 * 1024 * 1024, true, result => {
        assert.ok(!result.stalled, 'message stream was not consumed to the end');
        assert.ok(!result.thrown, 'uncaught exception: ' + result.thrown);
        assert.equal(result.err && result.err.code, 'EMAXLEN');
        finishTest();
    });
});
