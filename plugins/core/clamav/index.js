'use strict';

const PassThrough = require('stream').PassThrough;
const clamavClient = require('./clamav-client');

module.exports.title = 'ClamAV Virus Check';
module.exports.init = function(app, done) {
    app.addAnalyzerHook((envelope, source, destination) => {
        let interfaces = Array.isArray(app.config.interfaces) ? app.config.interfaces : [].concat(app.config.interfaces || []);
        if (!interfaces.includes(envelope.interface) && !interfaces.includes('*')) {
            return source.pipe(destination);
        }

        let clamStream = new PassThrough();

        clamavClient(app.config.port, app.config.host, clamStream, (err, response) => {
            if (err) {
                app.logger.error('Clamav', '%s RESULTS error="%s"', err.message);
                return;
            }
            if (response) {
                envelope.virus = response;
                app.logger.info('Clamav', '%s RESULTS clean=%s response="%s"', envelope.id, response.clean ? 'yes' : 'no', response.response);

                app.remotelog(envelope.id, false, 'VIRUSCHECK', {
                    result: response.clean ? 'clean' : 'infected',
                    response: response.response
                });
            }
        });

        clamStream.once('error', err => {
            source.emit('error', err);
        });

        destination.once('error', err => {
            source.emit('error', err);
        });

        let finished = false;
        let reading = false;
        let readNext = () => {
            let chunk = source.read();
            if (chunk === null) {
                if (finished) {
                    clamStream.end();
                }
                reading = false;
                return;
            }

            let drainClam = !clamStream.write(chunk);
            let drainDestination = !destination.write(chunk);

            let canContinue = () => {
                if (!drainClam && !drainDestination) {
                    return readNext();
                }
            };

            if (drainClam) {
                clamStream.once('drain', () => {
                    drainClam = false;
                    canContinue();
                });
            }

            if (drainDestination) {
                destination.once('drain', () => {
                    drainDestination = false;
                    canContinue();
                });
            }

            canContinue();
        };

        source.on('readable', () => {
            if (reading) {
                return;
            }
            reading = true;
            readNext();
        });

        source.once('end', () => {
            finished = true;
            if (reading) {
                return;
            }
            clamStream.end();
            destination.end();
        });
    });

    app.addHook('message:queue', (envelope, messageInfo, next) => {
        let interfaces = Array.isArray(app.config.interfaces) ? app.config.interfaces : [].concat(app.config.interfaces || []);
        if ((!interfaces.includes(envelope.interface) && !interfaces.includes('*')) || !envelope.virus) {
            return next();
        }

        if (!app.config.ignoreOrigins.includes(envelope.origin)) {
            if (!envelope.virus.clean) {
                return next(app.reject(envelope, 'virus', messageInfo, '550 This message contains a virus and may not be delivered'));
            }
        }

        next();
    });

    done();
};
