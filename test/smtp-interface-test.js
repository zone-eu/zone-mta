'use strict';

const test = require('node:test');
const assert = require('node:assert');

const SMTPInterface = require('../lib/smtp-interface');
const plugins = require('../lib/plugins');
const captureLogs = require('./fixtures/capture-logs');

function createLogger(loggerEnabled) {
    let smtpInterface = new SMTPInterface('feeder', { name: 'feeder', logger: loggerEnabled }, false);
    return { smtpInterface, logger: smtpInterface._createSMTPLogger() };
}

test('SMTP logger records rejected responses when the transcript is disabled', () => {
    captureLogs(entries => {
        let { smtpInterface, logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'BDAT' }, 'C:', 'BDAT 100');
        logger.debug({ tnx: 'send', cid: 'test-connection', user: 'sender@example.com' }, 'S:', '500 Error: command not recognized');

        assert.deepEqual(entries, [
            {
                level: 'info',
                prefix: smtpInterface.logName,
                message: 'SMTPRESPONSE id=test-connection user="sender@example.com" command="BDAT" response="500 Error: command not recognized"'
            }
        ]);
    });
});

test('SMTP logger ignores successful responses when the transcript is disabled', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'NOOP' }, 'C:', 'NOOP');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '250 OK');

        assert.deepEqual(entries, []);
    });
});

test('SMTP logger records temporary failures without attributing a completed command', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'NOOP' }, 'C:', 'NOOP');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '250 OK');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '421 Timeout - closing connection');

        assert.equal(entries.length, 1);
        assert.ok(/command=""/.test(entries[0].message));
        assert.ok(/response="421 Timeout - closing connection"/.test(entries[0].message));
    });
});

test('SMTP logger never records AUTH continuation payloads in rejection logs', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'AUTH' }, 'C:', 'AUTH LOGIN');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '334 VXNlcm5hbWU6');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'DXNLCKBLEGFTCGXLLMNVBQ==' }, 'C:', 'dXNlckBleGFtcGxlLmNvbQ==');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '334 UGFzc3dvcmQ6');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'C2VJCMV0' }, 'C:', 'c2VjcmV0');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '535 Error: Authentication credentials invalid');

        assert.equal(entries.length, 1);
        assert.ok(/command="AUTH"/.test(entries[0].message));
        assert.ok(!/DXNLCKBLEGFTCGXLLMNVBQ/.test(entries[0].message));
        assert.ok(!/C2VJCMV0/.test(entries[0].message));
    });
});

// smtp-server only emits a 334 when AUTH is supported. With authentication disabled AUTH is in
// disabledCommands, so a client that pipelines the whole exchange gets a 500 per continuation line
// and the base64 credentials must still stay out of the log
test('SMTP logger never records AUTH payloads pipelined without a challenge', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'AUTH' }, 'C:', 'AUTH LOGIN');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'DXNLCKBLEGFTCGXLLMNVBQ==' }, 'C:', 'dXNlckBleGFtcGxlLmNvbQ==');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'C2VJCMV0' }, 'C:', 'c2VjcmV0');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');

        assert.equal(entries.length, 3);
        assert.ok(/command="AUTH"/.test(entries[0].message));
        entries.forEach(entry => {
            assert.ok(!/DXNLCKBLEGFTCGXLLMNVBQ/.test(entry.message));
            assert.ok(!/C2VJCMV0/.test(entry.message));
        });
    });
});

// meta.command is the uppercased first token of the raw client input, not a validated verb
test('SMTP logger never echoes unknown client commands', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        let junk = 'A'.repeat(4000);
        logger.debug({ tnx: 'command', cid: 'test-connection', command: junk }, 'C:', junk);
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');

        assert.equal(entries.length, 1);
        assert.ok(/command=""/.test(entries[0].message));
        assert.ok(!/AAAA/.test(entries[0].message));
    });
});

// An unknown token must not inherit the attribution of the command that came before it
test('SMTP logger does not attribute an unknown command to the previous one', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'EHLO' }, 'C:', 'EHLO client.example.com');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '250 OK');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'NOTACOMMAND' }, 'C:', 'NOTACOMMAND');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');

        assert.equal(entries.length, 1);
        assert.ok(/command=""/.test(entries[0].message));
    });
});

test('SMTP logger quotes response text that contains quotes', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'RCPT' }, 'C:', 'RCPT TO:<user@example.com>');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '550 Unknown "recipient"');

        assert.equal(entries.length, 1);
        assert.ok(/response="550 Unknown \\"recipient\\""/.test(entries[0].message));
    });
});

test('SMTP logger forgets the command state of a closed connection', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'MAIL' }, 'C:', 'MAIL FROM:<sender@example.com>');
        logger.info({ tnx: 'close', cid: 'test-connection' }, 'Connection closed to %s', 'client.example.com');

        // reusing the id proves the entry is gone instead of being carried over
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '421 Server shutting down');

        assert.equal(entries.length, 1);
        assert.ok(/command=""/.test(entries[0].message));
    });
});

test('SMTP logger tracks connections independently', () => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'connection-a', command: 'MAIL' }, 'C:', 'MAIL FROM:<sender@example.com>');
        logger.debug({ tnx: 'command', cid: 'connection-b', command: 'RCPT' }, 'C:', 'RCPT TO:<user@example.com>');
        logger.debug({ tnx: 'send', cid: 'connection-b' }, 'S:', '550 No such user');
        logger.debug({ tnx: 'send', cid: 'connection-a' }, 'S:', '451 Try again later');

        assert.equal(entries.length, 2);
        assert.ok(/id=connection-b .* command="RCPT"/.test(entries[0].message));
        assert.ok(/id=connection-a .* command="MAIL"/.test(entries[1].message));
    });
});

test('SMTP logger preserves the optional full transcript', () => {
    captureLogs(entries => {
        let { smtpInterface, logger } = createLogger(true);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'BDAT' }, 'C:', 'BDAT 100');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');

        assert.equal(entries.length, 3);
        assert.deepEqual(entries[0], { level: 'silly', prefix: smtpInterface.options.name, message: 'C: BDAT 100' });
        assert.equal(entries[1].level, 'info');
        assert.deepEqual(entries[2], {
            level: 'silly',
            prefix: smtpInterface.options.name,
            message: 'S: 500 Error: command not recognized'
        });
    });
});

test('SMTP setup installs the rejection logger when the transcript is disabled', (_t, finishTest) => {
    let originalHandler = plugins.handler;
    let entries = [];

    let restore = () => {
        plugins.handler = originalHandler;
    };

    plugins.handler = {
        runHooks(name, args, callback) {
            setImmediate(callback);
        }
    };

    let smtpInterface = new SMTPInterface(
        'feeder',
        {
            name: 'feeder',
            hostname: 'localhost',
            logger: false,
            authentication: false,
            starttls: false,
            secure: false
        },
        false
    );

    let done = err => {
        restore();
        assert.ifError(err);
        finishTest();
    };

    // setup() reaches its callback asynchronously, so plugins.handler is restored from there
    smtpInterface.setup(err => {
        if (err) {
            return done(err);
        }

        try {
            captureLogs(captured => {
                entries = captured;
                // the logger reaches smtp-server through the constructor, wrapped by nodemailer
                smtpInterface.server.logger.debug({ tnx: 'command', cid: 'setup-connection', command: 'BDAT' }, 'C:', 'BDAT 100');
                smtpInterface.server.logger.debug({ tnx: 'send', cid: 'setup-connection' }, 'S:', '500 Error: command not recognized');
            });

            assert.equal(entries.length, 1);
            assert.equal(entries[0].level, 'info');
            assert.equal(entries[0].prefix, smtpInterface.logName);
            assert.ok(/command="BDAT"/.test(entries[0].message));
        } catch (E) {
            return done(E);
        }

        smtpInterface.close(() => done());
    });
});
