'use strict';

const config = require('config');
const iconv = require('iconv-lite');
const fetch = require('nodemailer-fetch');
const mailsplit = require('mailsplit');

module.exports = (id, envelope) => {
    let rewriter = new mailsplit.Rewriter(node => node.contentType === 'text/html', (node, html, callback) => {
        if (node.charset) {
            try {
                html = iconv.decode(html, node.charset);
            } catch (E) {
                html = html.toString();
            }
        } else {
            html = html.toString();
        }

        // enforce utf-8
        node.setCharset('utf-8');

        let rootNode = node;
        while (rootNode.parentNode) {
            rootNode = rootNode.parentNode;
        }

        let chunks = [];
        let chunklen = 0;
        let returned = false;
        let req = fetch(config.rewrite.url, {
            method: 'post',
            body: {
                id,
                messageId: rootNode.headers.getFirst('Message-ID'),
                from: envelope.from,
                to: envelope.to.join(','),
                html
            }
        });

        req.on('data', chunk => {
            chunks.push(chunk);
            chunklen += chunk.length;
        });

        req.on('error', err => {
            if (returned) {
                return;
            }
            returned = true;
            return callback(err);
        });
        req.on('end', () => {
            if (returned) {
                return;
            }
            returned = true;
            setImmediate(() => callback(null, Buffer.concat(chunks, chunklen)));
        });
    });
    return rewriter;
};
