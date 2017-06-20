'use strict';

const fetch = require('nodemailer/lib/fetch');
const addressTools = require('../../lib/address-tools');

module.exports.title = 'HTTP Sender Config';
module.exports.init = function(app, done) {
    let sessions = new WeakMap();

    let getConfig = (mailFrom, session, next) => {
        let returned = false;
        let stream = fetch(app.config.url, {
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

        stream.once('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            err.responseCode = 442;
            return next(err);
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
                return next(E);
            }

            if (data.error) {
                let err = new Error(data.error);
                err.responseCode = data.code;
                return next(err);
            }

            // there is no envelope yet at this point, so store
            // this information for later
            sessions.set(session, data);

            return next();
        });
    };

    let updateConfig = (envelope, session, next) => {
        if (sessions.has(session)) {
            let data = sessions.get(session);
            sessions.delete(session);
            Object.keys(data || {}).forEach(key => {
                envelope[key] = data[key];
            });
        }
        next();
    };

    // Listen for MAIL FROM command
    // Requests sender config from an API server
    app.addHook('smtp:mail_from', (address, session, next) => {
        let mailFrom = addressTools.normalizeAddress((address && address.address) || address);

        getConfig(mailFrom, session, next);
    });

    // Called when a mail is dropped to HTTP
    app.addHook('api:mail', (envelope, session, next) => {
        getConfig(envelope.from, session, err => {
            if (err) {
                return next(err);
            }
            updateConfig(envelope, session, next);
        });
    });

    app.addHook('smtp:data', updateConfig);

    done();
};
