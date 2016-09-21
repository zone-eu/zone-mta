'use strict';

const os = require('os');
const uuid = require('uuid');
const libmime = require('libmime');
const addressparser = require('addressparser');
const addressTools = require('../../lib/address-tools');
const sendingZone = require('../../lib/sending-zone');
const hostname = os.hostname();

module.exports.title = 'Default headers';
module.exports.init = function (app, done) {

    // Endusre default headers like Date, Message-ID etc
    app.addHook('message:headers', (envelope, next) => {
        // Check Message-ID: value. Add if missing
        let mId = envelope.headers.getFirst('message-id');
        if (!mId) {
            envelope.headers.remove('message-id'); // in case there's an empty value
            mId = '<' + uuid.v4() + '@' + (envelope.from.substr(envelope.from.lastIndexOf('@') + 1) || hostname) + '>';
            envelope.headers.add('Message-ID', mId);
        }
        envelope.messageId = mId;

        // Check Sending Zone for this message
        //   X-Sending-Zone: loopback
        // If Sending Zone is not set or missing then the default is used
        let sZone = envelope.headers.getFirst('x-sending-zone').toLowerCase();
        if (sZone) {
            app.logger.verbose('Queue', 'Detected Zone %s for %s by headers', sZone, mId);
            envelope.sendingZone = sZone;
        }

        // Check From: value. Add if missing or rewrite if needed
        let from = addressparser(envelope.headers.getFirst('from'));
        if (!from.length || from.length > 1 || envelope.rewriteFrom) {
            let rewriteFrom = envelope.rewriteFrom || {};
            if (typeof rewriteFrom === 'string') {
                rewriteFrom = addressparser(rewriteFrom).shift() || {};
            }
            from = from.shift() || {};

            if (from.group) {
                from = {};
            }

            try {
                from.name = libmime.decodeWords(from.name || rewriteFrom.name || '');
            } catch (E) {
                // most probably an unknown charset was used
                from.name = from.name || rewriteFrom.name || '';
            }

            if (!/^[\w ']*$/.test(from.name)) { // check if only contains letters and numbers and such
                if (/^[\x20-\x7e]*$/.test(from.name)) { // check if only contains ascii characters
                    from.name = '"' + from.name.replace(/([\\"])/g, '\\$1') + '"';
                } else { // requires mime encoding
                    from.name = libmime.encodeWord(from.name, 'Q', 52);
                }
            }

            from.address = rewriteFrom.address || from.address || envelope.from || ('auto-generated@' + hostname);
            envelope.headers.update('From', from.name ? from.name + ' <' + from.address + '>' : from.address);

            if (rewriteFrom.address) {
                envelope.from = rewriteFrom.address;
            }
        }

        // Check Date: value. Add if missing or invalid or future date
        let date = envelope.headers.getFirst('date');
        let dateVal = new Date(date);
        if (!date || dateVal.toString() === 'Invalid Date' || dateVal < new Date(1000)) {
            envelope.headers.remove('date'); // remove old empty or invalid values
            date = new Date().toUTCString().replace(/GMT/, '+0000');
            envelope.headers.add('Date', date);
        }

        // Check if Date header indicates a time in the future (+/- 300s clock skew is allowed)
        if (app.config.futureDate && date && dateVal.toString() !== 'Invalid Date' && dateVal.getTime() > Date.now() + 5 * 60 * 1000) {
            // The date is in the future, defer the message. Max defer time is 1 year
            envelope.deferDelivery = Math.min(dateVal.getTime(), Date.now() + 365 * 24 * 3600 * 1000);
        }

        envelope.date = date;

        // Fetch sender and receiver addresses
        envelope.parsedEnvelope = {
            from: addressTools.parseAddressList(envelope.headers, 'from').shift() || false,
            to: addressTools.parseAddressList(envelope.headers, 'to'),
            cc: addressTools.parseAddressList(envelope.headers, 'cc'),
            bcc: addressTools.parseAddressList(envelope.headers, 'bcc'),
            replyTo: addressTools.parseAddressList(envelope.headers, 'reply-to').shift() || false,
            sender: addressTools.parseAddressList(envelope.headers, 'sender').shift() || false
        };

        // Fetch X-FBL header for bounce tracking
        let xFbl = envelope.headers.getFirst('x-fbl').trim();
        if (xFbl) {
            envelope.fbl = xFbl;
        }

        if (app.config.xOriginatingIP && envelope.origin && !['127.0.0.1', '::1'].includes(envelope.origin)) {
            envelope.headers.update('X-Originating-IP', '[' + envelope.origin + ']');
        }

        // Remove sending-zone routing key if present
        envelope.headers.remove('x-sending-zone');

        // Remove BCC if present
        envelope.headers.remove('bcc');

        if (!envelope.sendingZone) {
            sZone = sendingZone.findByHeaders(envelope.headers);
            if (sZone) {
                app.logger.verbose('Queue', 'Detected Zone %s for %s by headers', sZone, mId);
                envelope.sendingZone = sZone;
            }
        }
        next();
    });

    app.addHook('sender:headers', (delivery, next) => {
        // Ensure that there is at least one recipient header

        let keys = delivery.headers.getList().map(line => line.key);
        for (let i = 0, len = keys.length; i < len; i++) {
            if (['to', 'cc', 'bcc'].includes(keys[i])) {
                return next();
            }
        }

        // No recipient addresses found, add a To:
        // This should not conflict DKIM signature
        delivery.headers.add('To', delivery.envelope.to);

        next();
    });

    done();
};
