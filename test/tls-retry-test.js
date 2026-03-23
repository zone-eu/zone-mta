'use strict';

const tlsRetry = require('../lib/tls-retry');

module.exports['Build default TLS options'] = test => {
    let tlsOptions = tlsRetry.getTlsOptions('mx.example', false, false);

    test.equal(tlsOptions.servername, 'mx.example');
    test.equal(tlsOptions.rejectUnauthorized, false);
    test.equal(tlsOptions.minVersion, 'TLSv1');
    test.ok(!('maxVersion' in tlsOptions));

    test.done();
};

module.exports['Build reduced ClientHello TLS options'] = test => {
    let tlsOptions = tlsRetry.getTlsOptions('mx.example', true, true);

    test.equal(tlsOptions.servername, 'mx.example');
    test.equal(tlsOptions.rejectUnauthorized, true);
    test.equal(tlsOptions.minVersion, 'TLSv1.3');
    test.equal(tlsOptions.maxVersion, 'TLSv1.3');
    test.equal(tlsOptions.ciphers, tlsRetry.REDUCED_TLS_CLIENT_HELLO_OPTIONS.ciphers);
    test.equal(tlsOptions.sigalgs, tlsRetry.REDUCED_TLS_CLIENT_HELLO_OPTIONS.sigalgs);
    test.equal(tlsOptions.ecdhCurve, tlsRetry.REDUCED_TLS_CLIENT_HELLO_OPTIONS.ecdhCurve);

    test.done();
};

module.exports['Retry reduced ClientHello only once for TLS handshake errors'] = test => {
    let timeoutErr = new Error('Timeout');
    timeoutErr.code = 'ETIMEDOUT';

    test.ok(tlsRetry.shouldRetryWithReducedClientHello(true, false, timeoutErr));
    test.ok(!tlsRetry.shouldRetryWithReducedClientHello(true, true, timeoutErr));
    test.ok(!tlsRetry.shouldRetryWithReducedClientHello(false, false, timeoutErr));

    test.done();
};

module.exports['Treat STARTTLS upgrade state as a TLS attempt'] = test => {
    test.ok(tlsRetry.isTlsAttempted({ upgrading: true }, false));
    test.ok(tlsRetry.isTlsAttempted({ secure: true }, false));
    test.ok(tlsRetry.isTlsAttempted(false, true));
    test.ok(!tlsRetry.isTlsAttempted({}, false));

    test.done();
};

module.exports['Do not retry reduced ClientHello for certificate failures'] = test => {
    let certErr = new Error('certificate has expired');
    certErr.code = 'ETLS';
    certErr.cert = { subject: 'CN=mx.example' };

    test.ok(!tlsRetry.shouldRetryWithReducedClientHello(true, false, certErr));
    test.ok(tlsRetry.shouldRetryWithoutTls(false, false, false, certErr));

    test.done();
};

module.exports['Only downgrade STARTTLS to plaintext when TLS is not policy-required'] = test => {
    let tlsErr = new Error('ssl3_get_record:wrong version number');
    tlsErr.code = 'ETLS';

    test.ok(tlsRetry.shouldRetryWithoutTls(false, false, false, tlsErr));
    test.ok(!tlsRetry.shouldRetryWithoutTls(false, false, true, tlsErr));
    test.ok(!tlsRetry.shouldRetryWithoutTls(true, false, false, tlsErr));
    test.ok(!tlsRetry.shouldRetryWithoutTls(false, true, false, tlsErr));

    test.done();
};
