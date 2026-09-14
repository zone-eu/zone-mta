'use strict';

const { SendingZone } = require('../lib/sending-zone');

module.exports['#speedometer spaces sequential deliveries evenly'] = test => {
    let zone = new SendingZone('test', { throttling: '10 messages/second' }, false);
    let ref = {};
    let releases = [];
    let scheduled = [];
    let currentTime = 0;
    let originalDateNow = Date.now;
    let originalSetTimeout = global.setTimeout;

    Date.now = () => currentTime;
    global.setTimeout = (callback, delay) => {
        scheduled.push({ callback, time: currentTime + delay });
    };

    let sendNext = () => {
        if (releases.length >= 7) {
            return;
        }

        zone.speedometer(ref, () => {
            releases.push(Date.now());
            setTimeout(sendNext, 1);
        });
    };

    try {
        sendNext();

        while (scheduled.length && releases.length < 7) {
            scheduled.sort((a, b) => a.time - b.time);
            let entry = scheduled.shift();
            currentTime = entry.time;
            entry.callback();
        }
    } finally {
        Date.now = originalDateNow;
        global.setTimeout = originalSetTimeout;
    }

    let gaps = releases.slice(1).map((release, i) => release - releases[i]);
    test.deepEqual(gaps, [101, 101, 101, 101, 101, 101]);
    test.done();
};
