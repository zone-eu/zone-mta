'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tlsRetry = require('../lib/tls-retry');

test('Build default TLS options', () => {
    let tlsOptions = tlsRetry.getTlsOptions('mx.example', false, false);

    assert.equal(tlsOptions.servername, 'mx.example');
    assert.equal(tlsOptions.rejectUnauthorized, false);
    assert.equal(tlsOptions.minVersion, 'TLSv1');
    assert.ok(!('maxVersion' in tlsOptions));
});

test('Build reduced ClientHello TLS options', () => {
    let tlsOptions = tlsRetry.getTlsOptions('mx.example', true, true);

    assert.equal(tlsOptions.servername, 'mx.example');
    assert.equal(tlsOptions.rejectUnauthorized, true);
    assert.equal(tlsOptions.minVersion, 'TLSv1.3');
    assert.equal(tlsOptions.maxVersion, 'TLSv1.3');
    assert.equal(tlsOptions.ciphers, tlsRetry.REDUCED_TLS_CLIENT_HELLO_OPTIONS.ciphers);
    assert.equal(tlsOptions.sigalgs, tlsRetry.REDUCED_TLS_CLIENT_HELLO_OPTIONS.sigalgs);
    assert.equal(tlsOptions.ecdhCurve, tlsRetry.REDUCED_TLS_CLIENT_HELLO_OPTIONS.ecdhCurve);
});

test('Retry reduced ClientHello only once for TLS handshake errors', () => {
    let timeoutErr = new Error('Timeout');
    timeoutErr.code = 'ETIMEDOUT';

    assert.ok(tlsRetry.isNetworkTimeout(timeoutErr));
    assert.ok(tlsRetry.shouldRetryWithReducedClientHello(true, false, timeoutErr));
    assert.ok(!tlsRetry.shouldRetryWithReducedClientHello(true, true, timeoutErr));
    assert.ok(!tlsRetry.shouldRetryWithReducedClientHello(false, false, timeoutErr));
});

test('Recognize mxConnect-generated network timeouts', () => {
    let timeoutErr = new Error('Network error when connecting to MX server mx.example[192.0.2.1] for example.com: Connection timed out when connecting to MX server');
    timeoutErr.category = 'network';
    timeoutErr.temporary = true;
    timeoutErr.response = 'Network error: Connection timed out when connecting to MX server';

    let connectionErr = new Error('Network error when connecting to MX server mx.example[192.0.2.1] for example.com: Connection refused');
    connectionErr.category = 'network';
    connectionErr.temporary = true;

    assert.ok(tlsRetry.isNetworkTimeout(timeoutErr));
    assert.ok(!tlsRetry.isNetworkTimeout(connectionErr));
});

test('Treat STARTTLS upgrade state as a TLS attempt', () => {
    assert.ok(tlsRetry.isTlsAttempted({ upgrading: true }, false));
    assert.ok(tlsRetry.isTlsAttempted({ secure: true }, false));
    assert.ok(tlsRetry.isTlsAttempted(false, true));
    assert.ok(!tlsRetry.isTlsAttempted({}, false));
});

test('Do not retry reduced ClientHello for certificate failures', () => {
    let certErr = new Error('certificate has expired');
    certErr.code = 'ETLS';
    certErr.cert = { subject: 'CN=mx.example' };

    assert.ok(!tlsRetry.shouldRetryWithReducedClientHello(true, false, certErr));
    assert.ok(tlsRetry.shouldRetryWithoutTls(false, false, false, certErr));
});

test('Only downgrade STARTTLS to plaintext when TLS is not policy-required', () => {
    let tlsErr = new Error('ssl3_get_record:wrong version number');
    tlsErr.code = 'ETLS';

    assert.ok(tlsRetry.shouldRetryWithoutTls(false, false, false, tlsErr));
    assert.ok(!tlsRetry.shouldRetryWithoutTls(false, false, true, tlsErr));
    assert.ok(!tlsRetry.shouldRetryWithoutTls(true, false, false, tlsErr));
    assert.ok(!tlsRetry.shouldRetryWithoutTls(false, true, false, tlsErr));
});
