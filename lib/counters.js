'use strict';

// Internal counters for debugging
module.exports.counters = new Map();
module.exports.started = new Date();
module.exports.count = (key, increment) => {
    increment = Number(increment) || 1;
    if (module.exports.counters.has(key)) {
        module.exports.counters.set(key, module.exports.counters.get(key) + increment);
    } else {
        module.exports.counters.set(key, increment);
    }
};
module.exports.clear = () => {
    module.exports.started = new Date();
    module.exports.counters.clear();
};
module.exports.list = () => {
    let list = [];
    module.exports.counters.forEach((value, key) => {
        list.push({
            key,
            value
        });
    });
    list = list.sort((a, b) => b.value - a.value);
    let result = {};
    list.forEach(item => {
        result[item.key] = item.value;
    });
    result.startTime = module.exports.started.toISOString();
    return result;
};
