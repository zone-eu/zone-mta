'use strict';

const tls = require('tls');

const REDUCED_TLS_CLIENT_HELLO_OPTIONS = Object.freeze({
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384',
    sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pkcs1_sha256:rsa_pkcs1_sha384',
    ecdhCurve: 'X25519:P-256:P-384'
});

const TLS_ERROR_RE =
    /SSL23_GET_SERVER_HELLO|\/deps\/openssl|ssl3_check|ssl3_get_record|SSL routines|disconnected\s+before\s+secure\s+TLS\s+connection\s+was\s+established|alert handshake failure|wrong version number/i;

function getTlsOptions(servername, enforceTLS, reducedClientHello) {
    let tlsOptions = {
        servername,
        rejectUnauthorized: enforceTLS,
        minVersion: enforceTLS ? 'TLSv1.2' : 'TLSv1'
    };

    if (reducedClientHello) {
        tlsOptions = Object.assign(tlsOptions, REDUCED_TLS_CLIENT_HELLO_OPTIONS);
    }

    return tlsOptions;
}

function isNetworkTimeout(err) {
    return !!(err && (err.code === 'ETIMEDOUT' || (err.category === 'network' && /timed out/i.test(err.message || err.response || ''))));
}

function isTlsRetryError(err) {
    return !!(err && !err.cert && (err.code === 'ETLS' || err.code === 'ECONNRESET' || isNetworkTimeout(err) || TLS_ERROR_RE.test(err.message || '')));
}

function isTlsFallbackError(err) {
    return !!(err && (err.code === 'ETLS' || err.code === 'ECONNRESET' || TLS_ERROR_RE.test(err.message || '')));
}

function isTlsAttempted(connection, secure) {
    return !!(
        secure ||
        (connection &&
            (connection.secure || connection.upgrading || (connection._socket && connection._socket.upgrading) || connection._socket instanceof tls.TLSSocket))
    );
}

function shouldRetryWithReducedClientHello(tlsAttempted, reducedClientHello, err) {
    return !!(tlsAttempted && !reducedClientHello && isTlsRetryError(err));
}

function shouldRetryWithoutTls(ignoreTLS, enforceTLS, secure, err) {
    return !!(!ignoreTLS && !enforceTLS && !secure && isTlsFallbackError(err));
}

module.exports.REDUCED_TLS_CLIENT_HELLO_OPTIONS = REDUCED_TLS_CLIENT_HELLO_OPTIONS;
module.exports.getTlsOptions = getTlsOptions;
module.exports.isTlsFallbackError = isTlsFallbackError;
module.exports.isTlsAttempted = isTlsAttempted;
module.exports.isNetworkTimeout = isNetworkTimeout;
module.exports.isTlsRetryError = isTlsRetryError;
module.exports.shouldRetryWithReducedClientHello = shouldRetryWithReducedClientHello;
module.exports.shouldRetryWithoutTls = shouldRetryWithoutTls;
