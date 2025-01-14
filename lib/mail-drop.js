'use strict';

const config = require('wild-config');
const log = require('npmlog');
const MessageParser = require('./message-parser');
const PassThrough = require('stream').PassThrough;
const LineEnds = require('./line-ends');
const plugins = require('./plugins');
const mailsplit = require('mailsplit');
const util = require('util');
const libmime = require('libmime');
const StreamHash = require('./stream-hash');
const SeqIndex = require('seq-index');
const _ = require('lodash')

let { BodyHashStream } = require('mailauth/lib/dkim/body');

const MAX_HEAD_SIZE = 2 * 1024 * 1024;

// Processes a message stream and stores it to queue

class MailDrop {
    constructor(queue) {
        this.queue = queue;
        this.seqIndex = new SeqIndex();
    }

    add(envelope, source, callback) {
        if (!this.queue) {
            return setImmediate(() => callback(new Error('Queue not yet initialized')));
        }

        envelope = envelope || {};

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
        const regularId = this.seqIndex.get(); 
        const signedId = this.seqIndex.get();
        const encryptedId = this.seqIndex.get();

        let messageInfo = {
            'message-id': '<>',
            from: envelope.from || '<>',
            to: [].concat(envelope.to || []).join(',') || '<>',
            src: envelope.origin,
            format() {
                let values = [];
                Object.keys(this).forEach(key => {
                    if (typeof this[key] === 'function' || typeof this[key] === 'undefined') {
                        return;
                    }
                    values.push(util.format('%s=%s', key, !/^"/.test(this[key]) && /\s/.test(this[key]) ? JSON.stringify(this[key]) : this[key]));
                });
                return values.join(' ');
            },
            keys() {
                let data = {};
                Object.keys(this).forEach(key => {
                    if (typeof this[key] === 'function' || typeof this[key] === 'undefined') {
                        return;
                    }
                    data[key] = this[key];
                });
                return data;
            }
        };

        let message = new MessageParser();
        message.onHeaders = (headers, next) => {
            envelope.headers = headers;

            headers
                .getDecoded('received')
                .reverse()
                .find(header => {
                    let match = (header.value || '').match(/\(Authenticated sender:\s*([^)]+)\)/i);
                    if (match) {
                        messageInfo.auth = match[1];
                        return true;
                    }
                });

            let subject = envelope.headers.getFirst('subject');
            try {
                subject = libmime.decodeWords(subject);
            } catch (E) {
                // ignore
            }
            subject = subject.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex
            if (subject.length > 128) {
                subject = subject.substr(0, 128) + '...[+' + (subject.length - 128) + 'B]';
            }
            messageInfo.subject = subject;

            plugins.handler.runHooks('message:headers', [envelope, messageInfo], err => {
                if (envelope.envelopeFromHeader) {
                    messageInfo.from = envelope.from || '<>';
                    messageInfo.to = [].concat(envelope.to || []).join(',') || '<>';
                }

                if (err) {
                    return setImmediate(() => next(err));
                }
                setImmediate(next);
            });
        };

        let raw = new PassThrough();
        let splitter = new mailsplit.Splitter({
            ignoreEmbedded: true,
            maxHeadSize: MAX_HEAD_SIZE
        });
        let streamer = new PassThrough({
            objectMode: true
        });

        envelope.dkim = envelope.dkim || {};
        envelope.dkim.hashAlgo = envelope.dkim.hashAlgo || config.dkim.hashAlgo || 'sha256';
        envelope.dkim.debug = envelope.dkim.hasOwnProperty('debug') ? envelope.dkim.debug : config.dkim.debug;

        let dkimStream = new BodyHashStream('relaxed/relaxed', envelope.dkim.hashAlgo);
        let lineEnds = new LineEnds();
        // Moved the DKIMStream Hash if not Sign EML

        plugins.handler.runAnalyzerHooks(envelope, source, raw);
        raw.pipe(splitter);
        plugins.handler.runRewriteHooks(envelope, splitter, streamer);
        plugins.handler.runStreamHooks(envelope, streamer, message);
        message.pipe(lineEnds).pipe(dkimStream);

        raw.once('error', err => {
            splitter.emit('error', err);
        });

        message.once('error', err => {
            dkimStream.emit('error', err);
        });

        plugins.handler.runHooks('message:store', [envelope, dkimStream], async (err) => {
            if (err) {
                if (dkimStream.readable) {
                    dkimStream.resume(); // let the original stream to end normally before displaying the error message
                }
                return setImmediate(() => callback(err));
            }

            let messageHashStream = new StreamHash({
                algo: 'md5'
            });

            if(!envelope.signEML) {
                //#region - Unsigned and Unencrypted
                // Moved the DKIMStream Hash Here
                dkimStream.on('hash', bodyHash => {
                    // store relaxed body hash for signing
                    envelope.dkim.bodyHash = bodyHash;
                    envelope.bodySize = dkimStream.byteLength;
                    messageInfo.body = envelope.bodySize || 0;
                });
                dkimStream.pipe(messageHashStream);
                dkimStream.once('error', err => {
                    messageHashStream.emit('error', err);
                });

                messageHashStream.on('hash', data => {
                    envelope.sourceMd5 = data.hash;
                    messageInfo.md5 = (data.hash || '?').substr(0, 12);
                });

                // store stream to db
                this.queue.store(id, messageHashStream, err => {
                    if (err) {
                        if (source.readable) {
                            source.resume(); // let the original stream to end normally before displaying the error message
                        }
                        if (/Error$/.test(err.name)) {
                            log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE store "%s" (%s)', envelope.sessionId, id, err.message, messageInfo.format());
                            let keys = messageInfo.keys();
                            ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                if (envelope[key] && !(key in keys)) {
                                    keys[key] = envelope[key];
                                }
                            });
                            keys.error = err.message;
                            plugins.handler.remotelog(id, false, 'NOQUEUE', keys);
                            return this.queue.removeMessage(id, () => callback(err));
                        }
                        return callback(err);
                    }

                    plugins.handler.runHooks('message:queue', [envelope, messageInfo], err => {
                        if (err) {
                            return setImmediate(() => this.queue.removeMessage(id, () => callback(err)));
                        }

                        let headerFrom = envelope.headers
                            .getDecoded('from')
                            .reverse()
                            .map(entry => entry.value)
                            .join(' ');

                        // convert headers object to a serialized array
                        envelope.headers = envelope.headers ? envelope.headers.getList() : [];

                        // inject message headers to the stored stream
                        this.queue.setMeta(id, envelope, err => {
                            if (err) {
                                log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE meta "%s" (%s)', envelope.sessionId, id, err.message, messageInfo.format());
                                let keys = messageInfo.keys();
                                ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                    if (envelope[key] && !(key in keys)) {
                                        keys[key] = envelope[key];
                                    }
                                });
                                keys.headerFrom = headerFrom;
                                keys.error = err.message;
                                plugins.handler.remotelog(id, false, 'NOQUEUE', keys);
                                return this.queue.removeMessage(id, () => callback(err));
                            }

                            // push delivery data
                            this.queue.push(id, envelope, err => {
                                let keys = messageInfo.keys();
                                ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                    if (envelope[key] && !(key in keys)) {
                                        keys[key] = envelope[key];
                                    }
                                });
                                keys.headerFrom = headerFrom;
                                if (err) {
                                    log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE push "%s" (%s)', envelope.sessionId, id, err.message, messageInfo.format());
                                    keys.error = err.message;
                                    plugins.handler.remotelog(id, false, 'NOQUEUE', keys);
                                    return this.queue.removeMessage(id, () => callback(err));
                                }

                                log.info('Queue/' + process.pid, 'id=%s %s QUEUED (%s)', envelope.sessionId, id, messageInfo.format());
                                plugins.handler.remotelog(id, false, 'QUEUED', keys);
                                return setImmediate(() => callback(null, 'Message queued as ' + id));
                            });
                        });
                    });
                });
                //#endregion - Unsigned and Unencrypted
            } else {
                const { regularStream, recipientsRegularValid, regularEnvelope, 
                    signedStream, recipientsSignedValid, signedEnvelope,
                    encryptedStream, recipientsEncryptedValid, encryptedEnvelope } = await envelope.signEML(raw);

                //#region - Regular Recipients
                if (recipientsRegularValid && recipientsRegularValid.length > 0) {
                    // Create Regular Envelope
                    regularEnvelope.id = regularId;
                    regularEnvelope.to = recipientsRegularValid;
                    
                    // Create Regular MessageInfo
                    let regularMessageInfo = _.cloneDeep(messageInfo);

                    // Create Regular StreamHash
                    let regularMessageHashStream = new StreamHash({
                        algo: 'md5'
                    });

                    // Create a new BodyHashStream and pipe the regular Stream
                    let regularBodyHash = new BodyHashStream('relaxed/relaxed', regularEnvelope.dkim.hashAlgo);
                    regularBodyHash.on('hash', bodyHash => {
                        // store relaxed body hash for signing
                        regularEnvelope.dkim.bodyHash = bodyHash;
                        regularEnvelope.bodySize = regularBodyHash.byteLength;
                        // re-write values for regularMessageInfo after signing/encryptiong
                        // BODY SIZE
                        regularMessageInfo.body = regularEnvelope.bodySize || 0;
                        // SUBJECT
                        let subjectUpdated = regularEnvelope.headers.getFirst('subject');
                        try {
                            subjectUpdated = libmime.decodeWords(subjectUpdated);
                        } catch (E) {
                            // ignore
                        }
                        subjectUpdated = subjectUpdated.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex
                        if (subjectUpdated.length > 128) {
                            subjectUpdated = subjectUpdated.substr(0, 128) + '...[+' + (subjectUpdated.length - 128) + 'B]';
                        }
                        regularMessageInfo.subject = subjectUpdated;
                        // RECIPIENTS/TO
                        regularMessageInfo.to = [].concat(recipientsRegularValid || []).join(',') || '<>';
                    });

                    regularStream.pipe(regularBodyHash);

                    regularBodyHash.pipe(regularMessageHashStream);
                    regularBodyHash.once('error', err => {
                        regularMessageHashStream.emit('error', err);
                    });

                    regularMessageHashStream.on('hash', data => {
                        regularEnvelope.sourceMd5 = data.hash;
                        regularMessageInfo.md5 = (data.hash || '?').substr(0, 12);
                    });

                    // store stream to db
                    this.queue.store(regularId, regularMessageHashStream, err => {
                        if (err) {
                            if (source.readable) {
                                source.resume(); // let the original stream to end normally before displaying the error message
                            }
                            if (/Error$/.test(err.name)) {
                                log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE store "%s" (%s)', regularEnvelope.sessionId, regularId, err.message, regularMessageInfo.format());
                                let keys = regularMessageInfo.keys();
                                ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                    if (regularEnvelope[key] && !(key in keys)) {
                                        keys[key] = regularEnvelope[key];
                                    }
                                });
                                keys.error = err.message;
                                plugins.handler.remotelog(regularId, false, 'NOQUEUE', keys);
                                return this.queue.removeMessage(regularId, () => callback(err));
                            }
                            return callback(err);
                        }

                        plugins.handler.runHooks('message:queue', [regularEnvelope, regularMessageInfo], err => {
                            if (err) {
                                return setImmediate(() => this.queue.removeMessage(regularId, () => callback(err)));
                            }

                            let headerFrom = regularEnvelope.headers
                                .getDecoded('from')
                                .reverse()
                                .map(entry => entry.value)
                                .join(' ');

                            // convert headers object to a serialized array
                            regularEnvelope.headers = regularEnvelope.headers ? regularEnvelope.headers.getList() : [];

                            // inject message headers to the stored stream
                            this.queue.setMeta(regularId, regularEnvelope, err => {
                                if (err) {
                                    log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE meta "%s" (%s)', regularEnvelope.sessionId, regularId, err.message, regularMessageInfo.format());
                                    let keys = regularMessageInfo.keys();
                                    ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                        if (regularEnvelope[key] && !(key in keys)) {
                                            keys[key] = regularEnvelope[key];
                                        }
                                    });
                                    keys.headerFrom = headerFrom;
                                    keys.error = err.message;
                                    plugins.handler.remotelog(regularId, false, 'NOQUEUE', keys);
                                    return this.queue.removeMessage(regularId, () => callback(err));
                                }

                                // push delivery data
                                this.queue.push(regularId, regularEnvelope, err => {
                                    let keys = regularMessageInfo.keys();
                                    ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                        if (regularEnvelope[key] && !(key in keys)) {
                                            keys[key] = regularEnvelope[key];
                                        }
                                    });
                                    keys.headerFrom = headerFrom;
                                    if (err) {
                                        log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE push "%s" (%s)', regularEnvelope.sessionId, regularId, err.message, regularMessageInfo.format());
                                        keys.error = err.message;
                                        plugins.handler.remotelog(regularId, false, 'NOQUEUE', keys);
                                        return this.queue.removeMessage(regularId, () => callback(err));
                                    }

                                    log.info('Queue/' + process.pid, 'id=%s %s QUEUED (%s)', regularEnvelope.sessionId, regularId, regularMessageInfo.format());
                                    plugins.handler.remotelog(regularId, false, 'QUEUED', keys);
                                    return setImmediate(() => callback(null, 'Message queued as ' + regularId));
                                });
                            });
                        });
                    });
                }
                //#endregion - Regular Recipients
                
                //#region - Encrypted Recipients
                if (recipientsEncryptedValid && recipientsEncryptedValid.length > 0) {
                    // Create Encrypted Envelope
                    encryptedEnvelope.id = encryptedId;
                    encryptedEnvelope.to = recipientsEncryptedValid;
                    
                    // Create Encrypted MessageInfo
                    let encryptedMessageInfo = _.cloneDeep(messageInfo);

                    // Create Encrypted StreamHash
                    let encryptedMessageHashStream = new StreamHash({
                        algo: 'md5'
                    });

                    // Create a new BodyHashStream and pipe the signed/encrypted Stream
                    let encryptedBodyHash = new BodyHashStream('relaxed/relaxed', encryptedEnvelope.dkim.hashAlgo);
                    encryptedBodyHash.on('hash', bodyHash => {
                        // store relaxed body hash for signing
                        encryptedEnvelope.dkim.bodyHash = bodyHash;
                        encryptedEnvelope.bodySize = encryptedBodyHash.byteLength;
                        // re-write values for encryptedMessageInfo after signing/encryptiong
                        // BODY SIZE
                        encryptedMessageInfo.body = encryptedEnvelope.bodySize || 0;
                        // SUBJECT
                        let subjectUpdated = encryptedEnvelope.headers.getFirst('subject');
                        try {
                            subjectUpdated = libmime.decodeWords(subjectUpdated);
                        } catch (E) {
                            // ignore
                        }
                        subjectUpdated = subjectUpdated.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex
                        if (subjectUpdated.length > 128) {
                            subjectUpdated = subjectUpdated.substr(0, 128) + '...[+' + (subjectUpdated.length - 128) + 'B]';
                        }
                        encryptedMessageInfo.subject = subjectUpdated;
                        // RECIPIENTS/TO
                        encryptedMessageInfo.to = [].concat(recipientsEncryptedValid || []).join(',') || '<>';
                    });

                    encryptedStream.pipe(encryptedBodyHash);

                    encryptedBodyHash.pipe(encryptedMessageHashStream);
                    encryptedBodyHash.once('error', err => {
                        encryptedMessageHashStream.emit('error', err);
                    });

                    encryptedMessageHashStream.on('hash', data => {
                        encryptedEnvelope.sourceMd5 = data.hash;
                        encryptedMessageInfo.md5 = (data.hash || '?').substr(0, 12);
                    });

                    // store stream to db
                    this.queue.store(encryptedId, encryptedMessageHashStream, err => {
                        if (err) {
                            if (source.readable) {
                                source.resume(); // let the original stream to end normally before displaying the error message
                            }
                            if (/Error$/.test(err.name)) {
                                log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE store "%s" (%s)', encryptedEnvelope.sessionId, encryptedId, err.message, encryptedMessageInfo.format());
                                let keys = encryptedMessageInfo.keys();
                                ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                    if (encryptedEnvelope[key] && !(key in keys)) {
                                        keys[key] = encryptedEnvelope[key];
                                    }
                                });
                                keys.error = err.message;
                                plugins.handler.remotelog(encryptedId, false, 'NOQUEUE', keys);
                                return this.queue.removeMessage(encryptedId, () => callback(err));
                            }
                            return callback(err);
                        }

                        plugins.handler.runHooks('message:queue', [encryptedEnvelope, encryptedMessageInfo], err => {
                            if (err) {
                                return setImmediate(() => this.queue.removeMessage(encryptedId, () => callback(err)));
                            }

                            let headerFrom = encryptedEnvelope.headers
                                .getDecoded('from')
                                .reverse()
                                .map(entry => entry.value)
                                .join(' ');

                            // convert headers object to a serialized array
                            encryptedEnvelope.headers = encryptedEnvelope.headers ? encryptedEnvelope.headers.getList() : [];

                            // inject message headers to the stored stream
                            this.queue.setMeta(encryptedId, encryptedEnvelope, err => {
                                if (err) {
                                    log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE meta "%s" (%s)', encryptedEnvelope.sessionId, encryptedId, err.message, encryptedMessageInfo.format());
                                    let keys = encryptedMessageInfo.keys();
                                    ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                        if (encryptedEnvelope[key] && !(key in keys)) {
                                            keys[key] = encryptedEnvelope[key];
                                        }
                                    });
                                    keys.headerFrom = headerFrom;
                                    keys.error = err.message;
                                    plugins.handler.remotelog(encryptedId, false, 'NOQUEUE', keys);
                                    return this.queue.removeMessage(encryptedId, () => callback(err));
                                }

                                // push delivery data
                                this.queue.push(encryptedId, encryptedEnvelope, err => {
                                    let keys = encryptedMessageInfo.keys();
                                    ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                        if (encryptedEnvelope[key] && !(key in keys)) {
                                            keys[key] = encryptedEnvelope[key];
                                        }
                                    });
                                    keys.headerFrom = headerFrom;
                                    if (err) {
                                        log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE push "%s" (%s)', encryptedEnvelope.sessionId, encryptedId, err.message, encryptedMessageInfo.format());
                                        keys.error = err.message;
                                        plugins.handler.remotelog(encryptedId, false, 'NOQUEUE', keys);
                                        return this.queue.removeMessage(encryptedId, () => callback(err));
                                    }

                                    log.info('Queue/' + process.pid, 'id=%s %s QUEUED (%s)', encryptedEnvelope.sessionId, encryptedId, encryptedMessageInfo.format());
                                    plugins.handler.remotelog(encryptedId, false, 'QUEUED', keys);
                                    return setImmediate(() => callback(null, 'Message queued as ' + encryptedId));
                                });
                            });
                        });
                    });
                }
                //#endregion - Encrypted Recipients

                //#region - Signed Recipients
                if (recipientsSignedValid && recipientsSignedValid.length > 0) {
                    signedEnvelope.id = signedId;
                    signedEnvelope.to = recipientsSignedValid;

                    let signedMessageInfo = _.cloneDeep(messageInfo);
                    let signedMessageHashStream = new StreamHash({
                        algo: 'md5'
                    });

                    let signedBodyHash = new BodyHashStream('relaxed/relaxed', signedEnvelope.dkim.hashAlgo);
                    signedBodyHash.on('hash', bodyHash => {
                        // store relaxed body hash for signing
                        signedEnvelope.dkim.bodyHash = bodyHash;
                        signedEnvelope.bodySize = signedBodyHash.byteLength;
                        // re-write values for encryptedMessageInfo after signing/encryptiong
                        // BODY SIZE
                        signedMessageInfo.body = signedEnvelope.bodySize || 0;
                        // SUBJECT
                        let subjectUpdated = signedEnvelope.headers.getFirst('subject');
                        try {
                            subjectUpdated = libmime.decodeWords(subjectUpdated);
                        } catch (E) {
                            // ignore
                        }
                        subjectUpdated = subjectUpdated.replace(/[\x00-\x1F]+/g, '_').trim(); //eslint-disable-line no-control-regex
                        if (subjectUpdated.length > 128) {
                            subjectUpdated = subjectUpdated.substr(0, 128) + '...[+' + (subjectUpdated.length - 128) + 'B]';
                        }
                        signedMessageInfo.subject = subjectUpdated;
                        // RECIPIENTS/TO
                        signedMessageInfo.to = [].concat(recipientsSignedValid || []).join(',') || '<>';
                    });

                    signedStream.pipe(signedBodyHash);

                    signedBodyHash.pipe(signedMessageHashStream);
                    signedBodyHash.once('error', err => {
                        signedMessageHashStream.emit('error', err);
                    });
    
                    signedMessageHashStream.on('hash', data => {
                        signedEnvelope.sourceMd5 = data.hash;
                        signedMessageInfo.md5 = (data.hash || '?').substr(0, 12);
                    });

                    // store stream to db
                    this.queue.store(signedId, signedMessageHashStream, err => {
                        if (err) {
                            if (source.readable) {
                                source.resume(); // let the original stream to end normally before displaying the error message
                            }
                            if (/Error$/.test(err.name)) {
                                log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE store "%s" (%s)', signedEnvelope.sessionId, signedId, err.message, signedMessageInfo.format());
                                let keys = signedMessageInfo.keys();
                                ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                    if (signedEnvelope[key] && !(key in keys)) {
                                        keys[key] = signedEnvelope[key];
                                    }
                                });
                                keys.error = err.message;
                                plugins.handler.remotelog(signedId, false, 'NOQUEUE', keys);
                                return this.queue.removeMessage(signedId, () => callback(err));
                            }
                            return callback(err);
                        }

                        plugins.handler.runHooks('message:queue', [signedEnvelope, signedMessageInfo], err => {
                            if (err) {
                                return setImmediate(() => this.queue.removeMessage(signedId, () => callback(err)));
                            }

                            let headerFrom = signedEnvelope.headers
                                .getDecoded('from')
                                .reverse()
                                .map(entry => entry.value)
                                .join(' ');

                            // convert headers object to a serialized array
                            signedEnvelope.headers = signedEnvelope.headers ? signedEnvelope.headers.getList() : [];

                            // inject message headers to the stored stream
                            this.queue.setMeta(signedId, signedEnvelope, err => {
                                if (err) {
                                    log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE meta "%s" (%s)', signedEnvelope.sessionId, signedId, err.message, signedMessageInfo.format());
                                    let keys = signedMessageInfo.keys();
                                    ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                        if (signedEnvelope[key] && !(key in keys)) {
                                            keys[key] = signedEnvelope[key];
                                        }
                                    });
                                    keys.headerFrom = headerFrom;
                                    keys.error = err.message;
                                    plugins.handler.remotelog(signedId, false, 'NOQUEUE', keys);
                                    return this.queue.removeMessage(signedId, () => callback(err));
                                }

                                // push delivery data
                                this.queue.push(signedId, signedEnvelope, err => {
                                    let keys = signedMessageInfo.keys();
                                    ['interface', 'originhost', 'transhost', 'transtype', 'user'].forEach(key => {
                                        if (signedEnvelope[key] && !(key in keys)) {
                                            keys[key] = signedEnvelope[key];
                                        }
                                    });
                                    keys.headerFrom = headerFrom;
                                    if (err) {
                                        log.error('Queue/' + process.pid, 'id=%s %s NOQUEUE push "%s" (%s)', signedEnvelope.sessionId, signedId, err.message, signedMessageInfo.format());
                                        keys.error = err.message;
                                        plugins.handler.remotelog(signedId, false, 'NOQUEUE', keys);
                                        return this.queue.removeMessage(signedId, () => callback(err));
                                    }

                                    log.info('Queue/' + process.pid, 'id=%s %s QUEUED (%s)', signedEnvelope.sessionId, signedId, signedMessageInfo.format());
                                    plugins.handler.remotelog(signedId, false, 'QUEUED', keys);
                                    return setImmediate(() => callback(null, 'Message queued as ' + signedId));
                                });
                            });
                        });
                    });
                }
                //#endregion - Signed Recipients
            }
        });
    }
}

module.exports = MailDrop;
