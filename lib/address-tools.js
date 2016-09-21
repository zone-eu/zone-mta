'use strict';

let addressparser = require('addressparser');
let punycode = require('punycode');

module.exports = {
    convertAddresses,
    parseAddressList,
    normalizeAddress,
    flatten
};

function convertAddresses(addresses, addressList) {
    addressList = addressList || new Set();

    flatten(addresses || []).forEach(address => {
        if (address.address) {
            addressList.add(normalizeAddress(address.address));
        } else if (address.group) {
            convertAddresses(address.group, addressList);
        }
    });

    return addressList;
}

function parseAddressList(headers, key) {
    let set = convertAddresses(headers.getDecoded(key).map(header => addressparser(header.value)));
    return Array.from(set);
}

function normalizeAddress(address) {
    if (!address) {
        return '';
    }
    let user = address.substr(0, address.lastIndexOf('@'));
    let domain = address.substr(address.lastIndexOf('@') + 1);
    return user.trim() + '@' + punycode.toASCII(domain.toLowerCase().trim());
}

// helper function to flatten arrays
function flatten(arr) {
    let flat = [].concat(...arr);
    return flat.some(Array.isArray) ? flatten(flat) : flat;
}
