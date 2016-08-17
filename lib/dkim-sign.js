'use strict';

const config = require('config');
const punycode = require('punycode');
const libmime = require('libmime');
const crypto = require('crypto');
const fs = require('fs');
const pathlib = require('path');
const log = require('npmlog');

module.exports.keys = new Map();

// TODO: Find a better solution of loading DKIM keys. Currently if you have a large number of keys it mights slow things down

try {
    // Reads all *.pem files from ./keys
    fs.readdirSync(config.dkim.keys).filter(file => /\.pem$/.test(file)).forEach(file => {
        let privateKey = fs.readFileSync(pathlib.join(config.dkim.keys, file));
        let parts = file.split('.');
        parts.pop();
        let keySelector = parts.pop();
        let domainName = parts.join('.');
        module.exports.keys.set(domainName, {
            domainName,
            keySelector,
            privateKey
        });
    });
} catch (E) {
    log.error('DKIM', 'Was not able to load DKIM keys');
    log.error('DKIM', E);
}

/**
 * Returns DKIM signature header line
 *
 * @param {Object} headers Parsed headers object from MessageParser
 * @param {String} bodyHash Base64 encoded hash of the message
 * @param {Object} options DKIM options
 * @param {String} options.domainName Domain name to be signed for
 * @param {String} options.keySelector DKIM key selector to use
 * @param {String} options.privateKey DKIM private key to use
 * @return {String} Complete header line
 */

module.exports.sign = (headers, bodyHash, options) => {
    options = options || {};

    // all listed fields from RFC4871 #5.5
    let defaultFieldNames = 'From:Sender:Reply-To:Subject:Date:Message-ID:To:' +
        'Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:' +
        'Content-Description:Resent-Date:Resent-From:Resent-Sender:' +
        'Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:' +
        'List-Id:List-Help:List-Unsubscribe:List-Subscribe:List-Post:' +
        'List-Owner:List-Archive';

    let fieldNames = options.headerFieldNames || defaultFieldNames;

    let canonicalizedHeaderData = relaxedHeaders(headers, fieldNames);
    let dkimHeader = generateDKIMHeader(options.domainName, options.keySelector, canonicalizedHeaderData.fieldNames, bodyHash);

    let signer, signature;

    canonicalizedHeaderData.headers += 'dkim-signature:' + relaxedHeaderLine(dkimHeader);

    signer = crypto.createSign(('rsa-' + config.dkim.hash).toUpperCase());
    signer.update(canonicalizedHeaderData.headers);
    signature = signer.sign(options.privateKey, 'base64');

    return dkimHeader + signature.replace(/(^.{73}|.{75}(?!\r?\n|\r))/g, '$&\r\n ').trim();
};

function generateDKIMHeader(domainName, keySelector, fieldNames, bodyHash) {
    let dkim = [
        'v=1',
        'a=rsa-' + config.dkim.hash,
        'c=relaxed/relaxed',
        'd=' + punycode.toASCII(domainName),
        'q=dns/txt',
        's=' + keySelector,
        'bh=' + bodyHash,
        'h=' + fieldNames
    ].join('; ');

    return libmime.foldLines('DKIM-Signature: ' + dkim, 76) + ';\r\n b=';
}

function relaxedHeaders(headers, fieldNames) {
    let includedFields = new Set();
    let headerFields = new Map();
    let headerLines = headers.getList();

    fieldNames.toLowerCase().split(':').forEach(field => {
        includedFields.add(field.trim());
    });

    for (let i = headerLines.length - 1; i >= 0; i--) {
        let line = headerLines[i];
        // only include the first value from bottom to top
        if (includedFields.has(line.key) && !headerFields.has(line.key)) {
            headerFields.set(line.key, relaxedHeaderLine(line.line));
        }
    }

    let headersList = [];
    let fields = [];
    includedFields.forEach(field => {
        if (headerFields.has(field)) {
            fields.push(field);
            headersList.push(field + ':' + headerFields.get(field));
        }
    });

    return {
        headers: headersList.join('\r\n') + '\r\n',
        fieldNames: fields.join(':')
    };
}

function relaxedHeaderLine(line) {
    return line.substr(line.indexOf(':') + 1).replace(/\r?\n/g, '').replace(/\s+/g, ' ').trim();
}
