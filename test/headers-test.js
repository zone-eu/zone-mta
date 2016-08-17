'use strict';

let createHeaders = require('../lib/headers');

module.exports['Return original headers'] = test => {
    let headerStr = 'Subject: test\nMIME-Version: 1.0\nMessage-ID: <abc@def>\n\n';
    let headers = createHeaders(Buffer.from(headerStr));
    test.equal(headers.build().toString(), headerStr);
    test.done();
};

module.exports['Return modified headers'] = test => {
    let origHeaderStr = 'Subject: test\nMIME-Version: 1.0\nMessage-ID: <abc@def>\n\n';
    let generatedHeaderStr = 'Subject: test\r\nMIME-Version: 1.0\r\nMessage-ID: <abc@def>\r\n\r\n';
    let headers = createHeaders(Buffer.from(origHeaderStr));
    headers._parseHeaders();
    headers.changed = true;
    test.equal(headers.build().toString(), generatedHeaderStr);
    test.done();
};

module.exports['Get specific headers'] = test => {
    let headerStr = 'Subject: test\nX-row: row1\nMIME-Version: 1.0\nX-Row: row2\nX-row: row3\nMessage-ID: <abc@def>\n\n';
    let headers = createHeaders(Buffer.from(headerStr));
    test.deepEqual(headers.get('x-row'), ['X-row: row1', 'X-Row: row2', 'X-row: row3']);
    test.done();
};

module.exports['Get first header value'] = test => {
    let headerStr = 'Subject: test\nX-row: row1\nMIME-Version: 1.0\nX-Row: row2\nX-row: row3\nMessage-ID: <abc@def>\n\n';
    let headers = createHeaders(Buffer.from(headerStr));
    test.equal(headers.getFirst('x-row'), 'row1');
    test.done();
};

module.exports['Get all rows'] = test => {
    let headerStr = 'Subject: test\nX-row: row1\nMIME-Version: 1.0\nX-Row: row2\nX-row: row3\nMessage-ID: <abc@def>\n\n';
    let headers = createHeaders(Buffer.from(headerStr));
    test.deepEqual(headers.getList('x-row'), [{
        key: 'subject',
        line: 'Subject: test'
    }, {
        key: 'x-row',
        line: 'X-row: row1'
    }, {
        key: 'mime-version',
        line: 'MIME-Version: 1.0'
    }, {
        key: 'x-row',
        line: 'X-Row: row2'
    }, {
        key: 'x-row',
        line: 'X-row: row3'
    }, {
        key: 'message-id',
        line: 'Message-ID: <abc@def>'
    }]);
    test.done();
};

module.exports['Add new header'] = test => {
    let origHeaderStr = 'Subject: test\nMIME-Version: 1.0\nMessage-ID: <abc@def>\n\n';
    let generatedHeaderStr = 'X-Test: tere\r\nSubject: test\r\nMIME-Version: 1.0\r\nMessage-ID: <abc@def>\r\n\r\n';
    let headers = createHeaders(Buffer.from(origHeaderStr));
    headers.add('X-Test', 'tere');
    test.equal(headers.build().toString(), generatedHeaderStr);
    test.done();
};

module.exports['Remove header'] = test => {
    let origHeaderStr = 'Subject: test\nMIME-Version: 1.0\nMessage-ID: <abc@def>\n\n';
    let generatedHeaderStr = 'Subject: test\r\nMessage-ID: <abc@def>\r\n\r\n';
    let headers = createHeaders(Buffer.from(origHeaderStr));
    headers.remove('MIME-Version');
    test.equal(headers.build().toString(), generatedHeaderStr);
    test.done();
};
