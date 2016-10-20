'use strict';

const restify = require('restify');
const path = require('path');

module.exports.title = 'ZoneMTA Web Admin';
module.exports.init = function (app, done) {

    let server = restify.createServer();

    server.use(restify.authorizationParser());
    server.use(restify.queryParser());
    server.use(restify.gzipResponse());
    server.use(restify.bodyParser({
        mapParams: true
    }));

    server.pre((request, response, next) => {
        app.logger.verbose('Admin', request.url);
        next();
    });

    server.get('/api/time', (req, res, next) => {
        let time = new Date().toISOString();

        // the actual response does not matter as long as it's 2xx range
        res.json({
            time
        });

        next();
    });

    server.get(/.*/, restify.serveStatic({
        directory: path.join(__dirname, 'public'),
        default: 'index.html'
    }));

    let returned = false;
    server.once('error', err => {
        if (returned) {
            return app.logger.error('API', err);
        }
        returned = true;
        return done(err);
    });

    server.listen(app.config.port, app.config.host, () => {
        if (returned) {
            return server.close();
        }
        returned = true;
        done();
    });

};
