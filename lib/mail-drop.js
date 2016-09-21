'use strict';

const log = require('npmlog');
const MessageParser = require('./message-parser');
const PassThrough = require('stream').PassThrough;
const DkimRelaxedBody = require('./dkim-relaxed-body');
const plugins = require('./plugins');
const mailsplit = require('mailsplit');

class MailDrop {
    constructor(options) {
        this.options = options || {};
        this.queue = false;
    }

    add(id, envelope, source, callback) {
        if (!this.queue) {
            return callback(new Error('Mailqueue not set up'));
        }

        id = id || this.queue.seqIndex.get();
        envelope = envelope || {};
        envelope.id = id;

        if (typeof source === 'string') {
            let messageBuf = Buffer.from(source);
            source = new PassThrough();
            source.end(messageBuf);
        } else if (Buffer.isBuffer(source)) {
            let messageBuf = source;
            source = new PassThrough();
            source.end(messageBuf);
        }

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

        envelope.dkim = envelope.dkim || {};
        envelope.dkim.hashAlgo = envelope.dkim.hashAlgo || (this.options.dkim && this.options.dkim.hashAlgo) || 'sha256';
        envelope.dkim.debug = this.options.dkim && this.options.dkim.debug;

        let dkimStream = new DkimRelaxedBody(envelope.dkim);
        dkimStream.on('hash', bodyHash => {
            // store relaxed body hash for signing
            envelope.dkim.bodyHash = bodyHash;
            envelope.bodySize = dkimStream.byteLength;
        });

        plugins.handler.runAnalyzerHooks(envelope, source, raw);
        raw.pipe(splitter);
        plugins.handler.runRewriteHooks(envelope, splitter, message);
        message.pipe(dkimStream);

        // pass on errors
        source.once('error', err => {
            raw.emit('error', err);
        });

        raw.once('error', err => {
            splitter.emit('error', err);
        });

        message.once('error', err => {
            dkimStream.emit('error', err);
        });

        // store stream to db
        this.queue.store(id, dkimStream, err => {
            if (err) {
                if (source.readable) {
                    source.resume(); // let the original stream to end normally before displaying the error message
                }
                log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                return callback(err);
            }

            plugins.handler.runHooks('message:store', [envelope], err => {
                if (err) {
                    return setImmediate(() => callback(err));
                }

                // convert headers object to a serialized array
                envelope.headers = envelope.headers ? envelope.headers.getList() : [];

                // inject message headers to the stored stream
                this.queue.setMeta(id, envelope, err => {
                    if (err) {
                        log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                        return callback(err);
                    }

                    // push delivery data
                    this.queue.push(id, envelope, err => {
                        if (err) {
                            log.error('Feeder', 'Error processing incoming message %s: %s (From: %s; To: %s)', envelope.messageId || id, err.message, envelope.from, toList);
                            return callback(err);
                        }
                        log.info('Feeder', 'RECEIVED %s %s (From: %s; To: %s)', id, envelope.messageId, envelope.from, toList);
                        return setImmediate(() => callback(null, 'Message queued as ' + id));
                    });
                });
            });
        });
    }
}

module.exports = MailDrop;
