'use strict';

class TtlCache {
    constructor(options) {
        options = options || {};
        this.defaultTtl = options.defaultTtl || 5 * 1000;

        this.data = new Map();
        this.sorted = [];
        this.checkTimer = null;
    }

    get(key) {
        if (!this.data.has(key)) {
            return null;
        }
        let data = this.data.get(key);
        return data && data.value;
    }

    set(key, value, ttl) {
        if (typeof ttl === 'undefined') {
            ttl = this.defaultTtl;
        }

        if (ttl <= 0) {
            return false;
        }

        let expires = Date.now() + ttl;

        let data = {
            key,
            value,
            ttl,
            expires
        };
        this.data.set(key, data);

        let added = false;

        for (let i = this.sorted.length - 1; i >= 0; i--) {
            if (this.sorted[i].key === key) {
                this.sorted.splice(i, 1);
            } else if (!added && this.sorted[i].expires <= expires) {
                this.sorted.splice(i + 1, 0, data);
                added = true;
            }
        }

        if (!added) {
            this.sorted.unshift(data);
        }

        setImmediate(()=>this.updateTimer());
    }

    updateTimer() {
        clearTimeout(this.checkTimer);

        if (!this.sorted.length) {
            return;
        }

        let expires = this.sorted[0].expires;
        let now = Date.now();

        if (expires <= now) {
            return setImmediate(()=>this.checkExpired());
        }

        let ttl = expires - now + 1;
        this.checkTimer = setTimeout(() => this.checkExpired(), ttl);
    }

    checkExpired() {
        let expired = 0;
        let now = Date.now();


        for (let i = 0, len = this.sorted.length; i < len; i++) {
            if (this.sorted[i].expires <= now) {
                expired++;
                this.data.delete(this.sorted[i].key);
            } else {
                break;
            }
        }

        if (expired === this.sorted.length || !this.data.size) {
            this.sorted = [];
        } else if (expired) {
            this.sorted.splice(0, expired);
        }

        setImmediate(()=>this.updateTimer());
    }

    remove(key) {
        if (!this.data.has(key)) {
            return false;
        }
        let data = this.data.get(key);
        this.data.delete(key);
        for (let i = 0, len = this.sorted.length; i < len; i++) {
            if (this.sorted[i] === data) {
                this.sorted.splice(i, 1);
                break;
            }
        }

        setImmediate(()=>this.updateTimer());
    }
}

module.exports = TtlCache;
