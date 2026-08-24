'use strict';

const util = require('util');
const log = require('npmlog');
const SMTPInterface = require('../lib/smtp-interface');
const plugins = require('../lib/plugins');

function captureLogs(callback) {
    let originalInfo = log.info;
    let originalSilly = log.silly;
    let entries = [];

    log.info = (...args) => entries.push({ level: 'info', prefix: args[0], message: util.format(...args.slice(1)) });
    log.silly = (...args) => entries.push({ level: 'silly', prefix: args[0], message: util.format(...args.slice(1)) });

    try {
        return callback(entries);
    } finally {
        log.info = originalInfo;
        log.silly = originalSilly;
    }
}

function createLogger(loggerEnabled) {
    let smtpInterface = new SMTPInterface('feeder', { name: 'feeder', logger: loggerEnabled }, false);
    return { smtpInterface, logger: smtpInterface._createSMTPLogger() };
}

module.exports['SMTP logger records rejected responses when the transcript is disabled'] = test => {
    captureLogs(entries => {
        let { smtpInterface, logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'BDAT' }, 'C:', 'BDAT 100');
        logger.debug({ tnx: 'send', cid: 'test-connection', user: 'sender@example.com' }, 'S:', '500 Error: command not recognized');

        test.deepEqual(entries, [
            {
                level: 'info',
                prefix: smtpInterface.logName,
                message:
                    'SMTPRESPONSE id="test-connection" user="sender@example.com" command="BDAT" response="500 Error: command not recognized"'
            }
        ]);
    });
    test.done();
};

module.exports['SMTP logger ignores successful responses when the transcript is disabled'] = test => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'NOOP' }, 'C:', 'NOOP');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '250 OK');

        test.deepEqual(entries, []);
    });
    test.done();
};

module.exports['SMTP logger records temporary failures without attributing a completed command'] = test => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'NOOP' }, 'C:', 'NOOP');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '250 OK');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '421 Timeout - closing connection');

        test.equal(entries.length, 1);
        test.ok(/command=""/.test(entries[0].message));
        test.ok(/response="421 Timeout - closing connection"/.test(entries[0].message));
    });
    test.done();
};

module.exports['SMTP logger never records AUTH continuation payloads in rejection logs'] = test => {
    captureLogs(entries => {
        let { logger } = createLogger(false);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'AUTH' }, 'C:', 'AUTH LOGIN');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '334 VXNlcm5hbWU6');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'dXNlckBleGFtcGxlLmNvbQ==' }, 'C:', 'dXNlckBleGFtcGxlLmNvbQ==');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '334 UGFzc3dvcmQ6');
        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'c2VjcmV0' }, 'C:', 'c2VjcmV0');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '535 Error: Authentication credentials invalid');

        test.equal(entries.length, 1);
        test.ok(/command="AUTH"/.test(entries[0].message));
        test.ok(!/dXNlckBleGFtcGxlLmNvbQ==/.test(entries[0].message));
        test.ok(!/c2VjcmV0/.test(entries[0].message));
    });
    test.done();
};

module.exports['SMTP logger preserves the optional full transcript'] = test => {
    captureLogs(entries => {
        let { smtpInterface, logger } = createLogger(true);

        logger.debug({ tnx: 'command', cid: 'test-connection', command: 'BDAT' }, 'C:', 'BDAT 100');
        logger.debug({ tnx: 'send', cid: 'test-connection' }, 'S:', '500 Error: command not recognized');

        test.equal(entries.length, 3);
        test.deepEqual(entries[0], { level: 'silly', prefix: smtpInterface.options.name, message: 'C: BDAT 100' });
        test.equal(entries[1].level, 'info');
        test.deepEqual(entries[2], {
            level: 'silly',
            prefix: smtpInterface.options.name,
            message: 'S: 500 Error: command not recognized'
        });
    });
    test.done();
};

module.exports['SMTP setup installs the rejection logger when the transcript is disabled'] = test => {
    let originalHandler = plugins.handler;
    let originalInfo = log.info;
    let entries = [];

    plugins.handler = {
        runHooks(name, args, callback) {
            setImmediate(callback);
        }
    };
    log.info = (...args) => entries.push({ prefix: args[0], message: util.format(...args.slice(1)) });

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

    smtpInterface.setup(err => {
        test.ifError(err);

        smtpInterface.server.logger.debug({ tnx: 'command', cid: 'setup-connection', command: 'BDAT' }, 'C:', 'BDAT 100');
        smtpInterface.server.logger.debug({ tnx: 'send', cid: 'setup-connection' }, 'S:', '500 Error: command not recognized');

        test.equal(entries.length, 1);
        test.equal(entries[0].prefix, smtpInterface.logName);
        test.ok(/command="BDAT"/.test(entries[0].message));

        plugins.handler = originalHandler;
        log.info = originalInfo;
        smtpInterface.close(() => test.done());
    });
};
