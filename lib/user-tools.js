'use strict';

const config = require('config');
const fetch = require('nodemailer-fetch');

/**
 * Fetches sender specific configuration
 *
 * @param  {[type]}   sender   [description]
 * @param  {Function} callback [description]
 * @return {[type]}            [description]
 */
module.exports.getSenderConfig = (mailFrom, session, callback) => {
    if (!config.getSenderConfig) {
        return setImmediate(() => callback(null, false));
    }

    let returned = false;
    let stream = fetch(config.getSenderConfig, {
        body: {
            from: mailFrom || '',
            origin: session.remoteAddress || '',
            originhost: session.clientHostname || '',
            transhost: session.hostNameAppearsAs || '',
            transtype: session.transmissionType || '',
            user: session.user || ''
        }
    });
    let chunks = [];
    let chunklen = 0;

    stream.on('readable', () => {
        let chunk;
        while ((chunk = stream.read()) !== null) {
            chunks.push(chunk);
            chunklen += chunk.length;
        }
    });

    stream.on('error', err => {
        if (returned) {
            return;
        }
        returned = true;
        err.responseCode = 442;
        return callback(err);
    });

    stream.on('end', () => {
        if (returned) {
            return;
        }
        returned = true;
        let data;
        let response = Buffer.concat(chunks, chunklen);

        try {
            data = JSON.parse(response.toString());
        } catch (E) {
            E.responseCode = 442;
            return callback(E);
        }

        if (data.error) {
            let err = new Error(data.error);
            err.responseCode = data.code;
            return callback(err);
        }

        return callback(null, data);
    });
};
