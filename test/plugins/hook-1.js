'use strict';

module.exports.title = 'Hook Test 1';

module.exports.init = (app, done) => {
    app.addHook('testhook', (a, b, next) => {
        a.incr++;
        b.incr++;
        return next();
    });

    done();
};
