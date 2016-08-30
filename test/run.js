'use strict';

// Test script to send messages to the feeder SMTP

// Usage to send 1234 messages using kreata.ee SMTP:
//  node test/run.js 1234 kreata.ee

const config = require('config');
const nodemailer = require('nodemailer');
const moment = require('moment');

let expecting = Number(process.argv[2]) || 100;
let destserver = process.argv[3] || 'localhost';
let rcptCount = Number(process.argv[4]) || 10;
let domainCount = Number(process.argv[5]) || 6;
let delayTTL = Number(process.argv[6]) || 0;

let port = config.feeder.port;
let destparts = destserver.split(':');
if (destparts.length > 1) {
    port = parseInt(destparts.pop(), 10) || port;
    destserver = destparts.join(':');
}

console.log('Sending %s messages (each %s recipients) to %s:%s', expecting, rcptCount, destserver, port); // eslint-disable-line no-console

let total = expecting;
let finished = false;

let startTime = new Date();
let sent = 0;
let errors = 0;

// Create a SMTP transporter object
const transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 10,
    host: destserver,
    port,
    auth: {
        user: config.feeder.user,
        pass: config.feeder.pass
    },
    logger: process.env.DEBUG === '1', // log to console
    debug: process.env.DEBUG === '1' // include SMTP traffic in the logs
}, {
    // default message fields
    // sender info
    from: 'Andris Test <andris@kreata.ee>'
});

let domainCounter = 0;

let send = () => {
    if (total-- <= 0) {
        finished = true;
        return;
    }

    let recipients = [];
    for (let i = 0; i < rcptCount; i++) {
        recipients += (i ? ', ' : '') + 'Test #' + (i + 1) + ' <test+' + (i + 1) + '@test' + (++domainCounter % domainCount + 1) + '.tahvel.info>';
    }

    // recipients = 'andris.reinman@gmail.com';

    // Message object
    let message = {

        //to: recipients,
        to: 'andris.reinman@gmail.com',
        // Comma separated list of recipients
        //to: '"Receiver Name" <andris@kreata.ee>, andris+2@kreata.ee, andris+3@kreata.ee, andris+4@kreata.ee, andris+5@kreata.ee, andris+6@kreata.ee, andris+7@kreata.ee, andris+8@kreata.ee, andris+9@kreata.ee, andris+10@kreata.ee, andris.reinman@gmail.com, andmekala@hot.ee, andris.reinman@hotmail.com, andris.reinman@yahoo.com',

        // Subject of the message
        subject: 'Nodemailer is unicode friendly ✔ ' + Date.now(), //

        // plaintext body
        text: 'Hello to myself!',

        // HTML body
        html: '<p><b>Hello</b> to myself <img src="cid:note@example.com"/></p>',

        /*
                headers: {
                    'X-Sending-Zone': [
                        'default', // default
                        'loopback'
                    ]
                },
        */

        headers: {
            // 'x-user-id': [1, '123', 3]
            'x-fbl': 'campaign-' + Date.now()
        },

        // An array of attachments
        attachments: [
            // String attachment
            {
                filename: 'notes.txt',
                content: 'Some notes about       this e-mail',
                contentType: 'text/plain' // optional, would be detected from the filename
            },

            // Binary Buffer attachment
            {
                filename: 'image.png',
                content: new Buffer('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAABlBMVEUAAAD/' +
                    '//+l2Z/dAAAAM0lEQVR4nGP4/5/h/1+G/58ZDrAz3D/McH8yw83NDDeNGe4U' +
                    'g9C9zwz3gVLMDA/A6P9/AFGGFyjOXZtQAAAAAElFTkSuQmCC', 'base64'),

                cid: 'note@example.com' // should be as unique as possible
            }, {
                filename: 'attachment.bin',
                content: Buffer.allocUnsafe(10 * 1024)
            }
        ]
    };

    transporter.sendMail(message, error => {
        if (error) {
            console.log(error.message); // eslint-disable-line no-console
            errors++;
            return;
        }
        sent++;
    });
};

if (!delayTTL) {
    transporter.on('idle', () => {
        setTimeout(() => {
            while (!finished && transporter.isIdle()) {
                send();
            }
        }, 100);
    });
} else {
    setInterval(send, delayTTL);
}

function stats() {
    console.log('Sent %s messages, errored %s (total %s, %s%), started %s (%s, %s)', sent, errors, sent + errors, Math.round((sent + errors) / expecting * 100), moment(startTime).fromNow(), startTime.getTime(), Date.now()); // eslint-disable-line no-console
    if (total <= 0) {
        process.exit(0);
    }
}

setInterval(stats, 10 * 1000);

console.log('Current time: %s (%s)', new Date().toString(), Date.now()); // eslint-disable-line no-console
stats();
