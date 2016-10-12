'use strict';

class QueueLocker {
    constructor() {

        this.locks = new Map();
        this.zones = new Map();
        this.senderInstances = new Map();
    }

    lockExists(key) {
        if (this.locks.has(key)) {
            let lock = this.locks.get(key);
            if (lock.ttl < Date.now()) {
                this.releaseLock(key);
            } else {
                return true;
            }
        }
        return false;
    }

    domainIsSkipped(zone, domain) {
        if (!domain) {
            return false;
        }

        if (!this.zones.has(zone)) {
            return false;
        }

        let zoneData = this.zones.get(zone);
        if (zoneData.skip && zoneData.skip.has(domain)) {
            return true;
        }

        return false;
    }

    lock(key, zone, domain, senderInstance, maxConnections) {
        if (this.lockExists(key)) {
            return false;
        }

        if (this.domainIsSkipped(zone, domain)) {
            return false;
        }

        let lock = {
            key,
            zone,
            domain,
            senderInstance,
            maxConnections,
            ttl: Date.now() + 10 * 60 * 1000
        };

        this.locks.set(key, lock);

        // link lock with sender instance
        if (!this.senderInstances.has(senderInstance)) {
            this.senderInstances.set(senderInstance, new Set());
        }
        this.senderInstances.get(senderInstance).add(lock);

        if (!this.zones.has(zone)) {
            this.zones.set(zone, {
                domains: new Map(),
                skip: new Set()
            });
        }
        let zoneData = this.zones.get(zone);

        // store reference for domain to zone
        if (!zoneData.domains.has(domain)) {
            zoneData.domains.set(domain, new Set());
        }
        zoneData.domains.get(domain).add(lock);

        if (zoneData.domains.get(domain).size >= maxConnections) {
            zoneData.skip.add(domain);
        } else {
            zoneData.skip.delete(domain);
        }

        return true;
    }

    release(data) {
        let key;

        if (data && typeof data === 'object') {
            if (data._lock) {
                key = data._lock;
                data._lock = null;
            }
        } else {
            key = data;
        }

        if (!key) {
            return false;
        }

        if (!this.locks.has(key)) {
            return false;
        }

        let lock = this.locks.get(key);
        this.locks.delete(key);

        if (this.senderInstances.has(lock.senderInstance)) {
            this.senderInstances.get(lock.senderInstance).delete(lock);
            if (!this.senderInstances.size) {
                this.senderInstances.delete(lock.senderInstance);
            }
        }

        if (this.zones.has(lock.zone)) {
            let zoneData = this.zones.get(lock.zone);
            if (zoneData.domains.has(lock.domain)) {
                let domainData = zoneData.domains.get(lock.domain);
                if (domainData.has(lock)) {
                    domainData.delete(lock);
                    if (domainData.size < lock.maxConnections && zoneData.skip.has(lock.domain)) {
                        zoneData.skip.delete(lock.domain);
                    }
                }
                if (!domainData.size) {
                    this.zones.delete(lock.zone);
                }
            }
        }

        return true;
    }

    removeSenderInstance(senderInstance) {
        if (!this.senderInstances.has(senderInstance)) {
            return false;
        }
        let keys = [];
        this.senderInstances.get(senderInstance).forEach(lock => keys.push(lock.key));
        keys.forEach(key => this.release(key));
    }
}

module.exports = QueueLocker;
