'use strict';

const { spawn } = require('child_process');
const path = require('path');

module.exports['Log lines from concurrent processes are not merged or split'] = test => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'log-lines.js')], {
        stdio: ['ignore', 'ignore', 'pipe']
    });

    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
        output += chunk;
    });

    child.on('close', () => {
        const lines = output.split('\n').filter(line => line);
        const broken = lines.filter(
            line => !/^info Sender\/test\/\d+ id=\d+ ACCEPTED from=sender@example\.com to=rcpt@example\.com$/.test(line)
        );

        test.equal(lines.length, 4 * 500);
        test.deepEqual(broken.slice(0, 5), []);
        test.done();
    });
};
