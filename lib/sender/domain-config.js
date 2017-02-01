'use strict';

class DomainConfig {
    constructor(options) {
        this.options = options || {};
        this.domains = new Map();
        this.defaults = this.options.defaults || {};

        // ensure defaults
        if (!this.defaults.maxConnections) {
            this.defaults.maxConnections = 5;
        }
        if (!this.defaults.disabledAddresses) {
            this.defaults.disabledAddresses = [];
        } else if (!Array.isArray(this.defaults.disabledAddresses)) {
            this.defaults.disabledAddresses = [].concat(this.defaults.disabledAddresses || []);
        }

        Object.keys(this.options).forEach(domain => {
            if (domain === 'default') {
                return;
            }
            Object.keys(this.options[domain] || {}).forEach(key => {
                this.set(domain, key, this.options[domain][key]);
            });
        });
    }

    set(domain, key, value) {
        if (!this.domains.has(domain)) {
            this.domains.set(domain, new Map());
        }
        this.domains.get(domain).set(key, value);
    }

    get(domain, key) {
        if (!this.domains.has(domain) || !this.domains.get(domain).has(key)) {
            if (this.defaults[key] && typeof this.defaults[key] === 'object') {
                // return clone
                return JSON.parse(JSON.stringify(this.defaults[key]));
            }
            // return defualt value
            return this.defaults[key];
        }
        return this.domains.get(domain).get(key);
    }

    remove(domain, key) {
        if (!this.domains.has(domain) || !this.domains.get(domain).has(key)) {
            return;
        }
        this.domains.get(domain).delete(key);
        if (!this.domains.get(domain).size) {
            this.domains.delete(domain);
        }
    }
}

module.exports = DomainConfig;
