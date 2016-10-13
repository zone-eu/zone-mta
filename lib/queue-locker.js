'use strict';

class QueueLocker {
    constructor() {
        this.defaultTtl = 10 * 60 * 1000;

        this.locks = new Map();
        this.zones = new Map();
        this.lockOwners = new Map();

        this.nextTtlCheck = Infinity;
        this.lockCheckTimer = false;
    }

    lockExists(key) {
        if (this.locks.has(key)) {
            let lock = this.locks.get(key);
            if (lock.ttl < Date.now()) {
                this.release(key);
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

    lock(key, zone, domain, lockOwner, maxConnections) {
        if (this.lockExists(key)) {
            return false;
        }

        if (this.domainIsSkipped(zone, domain)) {
            return false;
        }

        let ttl = Date.now() + this.defaultTtl;

        let lock = {
            key,
            zone,
            domain,
            lockOwner,
            maxConnections: Number(maxConnections) || 0,
            ttl,
            created: new Date()
        };

        this.locks.set(key, lock);

        if (ttl < this.nextTtlCheck) {
            this.nextTtlCheck = ttl;
            clearTimeout(this.lockCheckTimer);
            this.lockCheckTimer = setTimeout(() => this.checkTtl(), Math.max(ttl + 1 - Date.now(), 0));
            this.lockCheckTimer.unref();
        }

        // link lock with sender instance
        if (!this.lockOwners.has(lockOwner)) {
            this.lockOwners.set(lockOwner, new Set());
        }
        this.lockOwners.get(lockOwner).add(lock);

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

        if (maxConnections && zoneData.domains.get(domain).size >= maxConnections) {
            zoneData.skip.add(domain);
        } else if (zoneData.skip.has(domain)) {
            zoneData.skip.delete(domain);
        }

        return true;
    }

    release(key) {
        if (!key) {
            return false;
        }

        if (!this.locks.has(key)) {
            return false;
        }

        let lock = this.locks.get(key);
        this.locks.delete(key);

        if (this.lockOwners.has(lock.lockOwner)) {
            this.lockOwners.get(lock.lockOwner).delete(lock);
            if (!this.lockOwners.get(lock.lockOwner).size) {
                this.lockOwners.delete(lock.lockOwner);
            }
        }

        if (this.zones.has(lock.zone)) {
            let zoneData = this.zones.get(lock.zone);
            if (zoneData.domains.has(lock.domain)) {
                let domainData = zoneData.domains.get(lock.domain);
                if (domainData.has(lock)) {
                    domainData.delete(lock);
                    if ((!lock.maxConnections || domainData.size < lock.maxConnections) && zoneData.skip.has(lock.domain)) {
                        zoneData.skip.delete(lock.domain);
                    }
                }
                if (!domainData.size) {
                    zoneData.domains.delete(lock.domain);
                }
                if (!zoneData.domains.size) {
                    this.zones.delete(lock.zone);
                }
            }
        }

        if (!this.locks.size) {
            clearTimeout(this.lockCheckTimer);
            this.nextTtlCheck = Infinity;
        }

        return true;
    }

    releaseLockOwner(lockOwner) {
        if (!this.lockOwners.has(lockOwner)) {
            return false;
        }
        let keys = [];
        this.lockOwners.get(lockOwner).forEach(lock => keys.push(lock.key));
        keys.forEach(key => this.release(key));
    }

    checkTtl() {
        clearTimeout(this.lockCheckTimer);

        let now = Date.now();
        let expired = [];

        this.nextTtlCheck = Infinity;
        this.locks.forEach(lock => {
            if (lock.ttl <= now) {
                expired.push(lock.key);
            } else if (lock.ttl < this.nextTtlCheck) {
                this.nextTtlCheck = lock.ttl;
            }
        });
        expired.forEach(key => this.release(key));
        if (this.locks.size) {
            this.lockCheckTimer = setTimeout(() => this.checkTtl(), Math.max(this.nextTtlCheck + 1 - Date.now(), 0));
            this.lockCheckTimer.unref();
        }
    }
}

module.exports = QueueLocker;
