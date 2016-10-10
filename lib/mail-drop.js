'use strict';

const config = require('config');
const log = require('npmlog');
const MessageParser = require('./message-parser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const plugins = require('./plugins');
const mailsplit = require('mailsplit');

// Processes a message stream and stores it to queue

class MailDrop {
    constructor() {
        this.queue = false;
    }

    add(envelope, source, callback) {
        if (!this.queue) {
            return callback(new Error('Mailqueue not set up'));
        }

        envelope = envelope || {};
        envelope.id = envelope.id || this.queue.seqIndex.get();

        if (typeof source === 'string') {
            let messageBuf = Buffer.from(source);
            source = new PassThrough();
            source.once('error', err => callback(err));
            source.end(messageBuf);
        } else if (Buffer.isBuffer(source)) {
            let messageBuf = source;
            source = new PassThrough();
            source.once('error', err => callback(err));
            source.end(messageBuf);
        }

        let id = envelope.id;

        // Create capped list of recipient addresses for logging
        let toList = [].concat(envelope.to);
        if (toList.length > 5) {
            let listlength = toList.length;
            toList = toList.slice(0, 4);
            toList.push('and ' + (listlength - toList.length) + ' more...');
        }
        toList = toList.join(',');

        let message = new MessageParser();
        message.onHeaders = (headers, next) => {
            envelope.headers = headers;
            plugins.handler.runHooks('message:headers', [envelope], err => {
                if (err) {
                    return setImmediate(() => next(err));
                }
                setImmediate(next);
            });
        };

        let raw = new PassThrough();
        let splitter = new mailsplit.Splitter({
            ignoreEmbedded: true
        });
        let streamer = new PassThrough({
            objectMode: true
        });

        envelope.dkim = envelope.dkim || {};
        envelope.dkim.hashAlgo = envelope.dkim.hashAlgo || config.dkim.hashAlgo || 'sha256';
        envelope.dkim.debug = envelope.dkim.hasOwnProperty('debug') ? envelope.dkim.debug : config.dkim.debug;

        let dkimStream = new DkimRelaxedBody(envelope.dkim);
        dkimStream.on('hash', bodyHash => {
            // store relaxed body hash for signing
            envelope.dkim.bodyHash = bodyHash;
            envelope.bodySize = dkimStream.byteLength;
        });

        plugins.handler.runAnalyzerHooks(envelope, source, raw);
        raw.pipe(splitter);
        plugins.handler.runRewriteHooks(envelope, splitter, streamer);
        plugins.handler.runStreamHooks(envelope, streamer, message);
        message.pipe(dkimStream);

        splitter.once('error', err => {
            raw.emit('error', err);
        });

        dkimStream.once('error', err => {
            message.emit('error', err);
        });

        plugins.handler.runHooks('message:store', [envelope, dkimStream], err => {
            if (err) {
                return setImmediate(() => callback(err));
            }

            // store stream to db
            this.queue.store(id, dkimStream, err => {
                if (err) {
                    if (source.readable) {
                        source.resume(); // let the original stream to end normally before displaying the error message
                    }
                    log.error('Queue', '%s NOQUEUE "%s" (message-id=%s from=%s to=%s)', id, err.message, envelope.messageId, envelope.from, toList);
                    return callback(err);
                }

                plugins.handler.runHooks('message:queue', [envelope], err => {
                    if (err) {
                        return setImmediate(() => callback(err));
                    }

                    // convert headers object to a serialized array
                    envelope.headers = envelope.headers ? envelope.headers.getList() : [];

                    // inject message headers to the stored stream
                    this.queue.setMeta(id, envelope, err => {
                        if (err) {
                            log.error('Queue', '%s NOQUEUE "%s" (message-id=%s from=%s to=%s)', id, err.message, envelope.messageId, envelope.from, toList);
                            return callback(err);
                        }

                        // push delivery data
                        this.queue.push(id, envelope, err => {
                            if (err) {
                                log.error('Queue', '%s NOQUEUE "%s" (message-id=%s from=%s to=%s)', id, err.message, envelope.messageId, envelope.from, toList);
                                return callback(err);
                            }
                            log.info('Queue', '%s QUEUED (message-id=%s from=%s to=%s)', id, envelope.messageId, envelope.from, toList);
                            return setImmediate(() => callback(null, 'Message queued as ' + id));
                        });
                    });
                });
            });
        });
    }
}

module.exports = MailDrop;
