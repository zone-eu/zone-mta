'use strict';

const libmime = require('libmime');

/**
 * Class Headers to parse and handle message headers. Headers instance allows to
 * check existing, delete or add new headers
 */
class Headers {
    constructor(headers) {
        if (Array.isArray(headers)) {
            // already using parsed headers
            this.changed = true;
            this.headers = false;
            this.parsed = true;
            this.lines = headers;
        } else {
            // using original string/buffer headers
            this.changed = false;
            this.headers = headers;
            this.parsed = false;
            this.lines = false;
        }
    }

    get(key) {
        if (!this.parsed) {
            this._parseHeaders();
        }
        key = this._normalizeHeader(key);
        let lines = this.lines.filter(line => line.key === key).map(line => line.line);

        return lines;
    }

    getDecoded(key) {
        return this.get(key).map(line => libmime.decodeHeader(line)).filter(line => line && line.value);
    }

    getFirst(key) {
        if (!this.parsed) {
            this._parseHeaders();
        }
        key = this._normalizeHeader(key);
        let header = this.lines.find(line => line.key === key);
        if (!header) {
            return '';
        }
        return ((libmime.decodeHeader(header.line) || {}).value || '').toString().trim();
    }

    getList() {
        if (!this.parsed) {
            this._parseHeaders();
        }
        return this.lines;
    }

    add(key, value, index) {
        if (typeof value === 'string') {
            value = Buffer.from(value);
        }
        value = value.toString('binary');
        this.addFormatted(key, libmime.foldLines(key + ': ' + value.replace(/\r?\n/g, ''), 76, false), index);
    }

    addFormatted(key, line, index) {
        if (!this.parsed) {
            this._parseHeaders();
        }
        index = index || 0;
        this.changed = true;
        let header = {
            key: this._normalizeHeader(key),
            line
        };

        if (index < 1) {
            this.lines.unshift(header);
        } else if (index >= this.lines.length) {
            this.lines.push(header);
        } else {
            this.lines.splice(index, 0, header);
        }
    }

    remove(key) {
        if (!this.parsed) {
            this._parseHeaders();
        }
        key = this._normalizeHeader(key);
        for (let i = this.lines.length - 1; i >= 0; i--) {
            if (this.lines[i].key === key) {
                this.changed = true;
                this.lines.splice(i, 1);
            }
        }
    }

    build() {
        if (!this.changed) {
            return typeof this.headers === 'string' ? Buffer.from(this.headers, 'binary') : this.headers;
        }
        return Buffer.from(this.lines.map(line => line.line).join('\r\n') + '\r\n\r\n', 'binary');
    }

    _normalizeHeader(key) {
        return (key || '').toLowerCase().trim();
    }

    _parseHeaders() {
        let lines = this.headers.toString('binary').replace(/[\r\n]+$/, '').split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            let chr = lines[i].charAt(0);
            if (i && (chr === ' ' || chr === '\t')) {
                lines[i - 1] += '\r\n' + lines[i];
                lines.splice(i, 1);
            } else {
                let line = lines[i];
                let key = this._normalizeHeader(line.substr(0, line.indexOf(':')));
                lines[i] = {
                    key,
                    line
                };
            }
        }
        this.lines = lines;
        this.parsed = true;
    }
}

// expose to the world
module.exports = headers => new Headers(headers);
