'use strict';

const os = require('os');
const uuid = require('uuid');
const addressTools = require('../../lib/address-tools');
const sendingZone = require('../../lib/sending-zone');
const hostname = os.hostname();

module.exports.title = 'Default headers';
module.exports.init = function(app, done) {
    const addMissing = [].concat(app.config.addMissing || []).map(key => (key || '').toString().toLowerCase().trim());

    // Endusre default headers like Date, Message-ID etc
    app.addHook('message:headers', (envelope, messageInfo, next) => {
        // Fetch sender and receiver addresses
        envelope.parsedEnvelope = {
            from: addressTools.parseAddressList(envelope.headers, 'from').shift() || false,
            to: addressTools.parseAddressList(envelope.headers, 'to'),
            cc: addressTools.parseAddressList(envelope.headers, 'cc'),
            bcc: addressTools.parseAddressList(envelope.headers, 'bcc'),
            replyTo: addressTools.parseAddressList(envelope.headers, 'reply-to').shift() || false,
            sender: addressTools.parseAddressList(envelope.headers, 'sender').shift() || false
        };

        if (envelope.envelopeFromHeader) {
            envelope.from = envelope.parsedEnvelope.from || envelope.parsedEnvelope.sender || '';
            envelope.to = [].concat(envelope.parsedEnvelope.to || []).concat(envelope.parsedEnvelope.cc || []).concat(envelope.parsedEnvelope.bcc || []);
        }

        // Check Message-ID: value. Add if missing
        let mId = envelope.headers.getFirst('message-id');
        if (!mId) {
            mId = '<' + uuid.v4() + '@' + (envelope.from.substr(envelope.from.lastIndexOf('@') + 1) || hostname) + '>';
            if (addMissing.includes('message-id')) {
                envelope.headers.remove('message-id'); // in case there's an empty value
                envelope.headers.add('Message-ID', mId);
            }
        }
        envelope.messageId = mId;
        messageInfo['message-id'] = envelope.messageId;

        // Check Sending Zone for this message
        //   X-Sending-Zone: loopback
        // If Sending Zone is not set or missing then the default is used
        if (!envelope.sendingZone && app.config.allowRoutingHeaders.includes(envelope.interface)) {
            let sZone = envelope.headers.getFirst('x-sending-zone').toLowerCase();
            if (sZone) {
                app.logger.verbose('Queue', 'Detected Zone %s for %s by headers', sZone, mId);
                envelope.sendingZone = sZone;
            }
        }

        // Check Date: value. Add if missing or invalid or future date
        let date = envelope.headers.getFirst('date');
        let dateVal = new Date(date);
        if (!date || dateVal.toString() === 'Invalid Date' || dateVal < new Date(1000)) {
            date = new Date().toUTCString().replace(/GMT/, '+0000');
            if (addMissing.includes('date')) {
                envelope.headers.remove('date'); // remove old empty or invalid values
                envelope.headers.add('Date', date);
            }
        }

        // Check if Date header indicates a time in the future (+/- 300s clock skew is allowed)
        if (app.config.futureDate && date && dateVal.toString() !== 'Invalid Date' && dateVal.getTime() > Date.now() + 5 * 60 * 1000) {
            // The date is in the future, defer the message. Max defer time is 1 year
            envelope.deferDelivery = Math.min(dateVal.getTime(), Date.now() + 365 * 24 * 3600 * 1000);
        }

        envelope.date = date;

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
            let sZone = sendingZone.findByHeaders(envelope.headers);
            if (sZone) {
                app.logger.verbose('Queue', 'Detected Zone %s for %s by headers', sZone, mId);
                envelope.sendingZone = sZone;
            }
        }

        next();
    });

    app.addHook('sender:headers', (delivery, connection, next) => {
        // Ensure that there is at least one recipient header

        let hasRecipient = false;
        let hasContent = false;
        let hasMime = false;

        let keys = delivery.headers.getList().map(line => line.key);
        for (let i = 0, len = keys.length; i < len; i++) {
            if (!hasRecipient && ['to', 'cc', 'bcc'].includes(keys[i])) {
                hasRecipient = true;
            }
            if (!hasMime && keys[i] === 'mime-version') {
                hasMime = true;
            }
            if (!hasContent && ['content-transfer-encoding', 'content-type', 'content-disposition'].includes(keys[i])) {
                hasContent = true;
            }
        }

        if (!hasRecipient && addMissing.includes('to')) {
            // No recipient addresses found, add a To:
            // This should not conflict DKIM signature
            delivery.headers.add('To', delivery.envelope.to);
        }

        if (hasContent && !hasMime && addMissing.includes('mime-version')) {
            // Add MIME-Version to bottom
            delivery.headers.add('MIME-Version', '1.0', Infinity);
        }

        next();
    });

    done();
};
