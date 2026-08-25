'use strict';

const log = require('npmlog');

// Connections that are refused before they reach an SMTP server never pass through
// smtp-server's logger, so the SMTPRESPONSE line in lib/smtp-interface.js does not cover
// them. Both the master proxy and the receiver worker record them through here so the two
// processes emit the same line for log parsers to consume.
const logSmtpReject = (logName, socket, message) => {
    log.info(logName, 'SMTPREJECT src=%s response=%s', (socket && socket.remoteAddress) || '', JSON.stringify(message));
};

module.exports = { logSmtpReject };
