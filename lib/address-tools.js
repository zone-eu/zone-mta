'use strict';

let addressparser = require('addressparser');
let punycode = require('punycode');
let libmime = require('libmime');

module.exports = {
    convertAddresses,
    parseAddressList,
    parseAddressses,
    normalizeAddress,
    flatten,
    validateAddress
};

function validateAddress(headers, key) {
    let addressList = parseAddressList(headers, key, true);
    return {
        addresses: addressList.map(address => address.address),
        set: address => {
            let values = [];
            parseAddressses([].concat(address || []), true).forEach(parsed => {
                if (!parsed || !parsed.address) {
                    return;
                }
                if (!parsed.name) {
                    let existing = addressList.find(entry => entry.address === parsed.address);
                    if (existing && existing.name) {
                        parsed.name = existing.name;
                    }
                }

                try {
                    parsed.name = libmime.decodeWords(parsed.name || '');
                    if (!/^[\w ']*$/.test(parsed.name)) { // check if contains only letters and numbers and such
                        if (/^[\x20-\x7e]*$/.test(parsed.name)) { // check if only contains ascii characters
                            parsed.name = '"' + parsed.name.replace(/([\\"])/g, '\\$1') + '"';
                        } else { // requires mime encoding
                            parsed.name = libmime.encodeWord(parsed.name, 'Q', 52);
                        }
                    }
                } catch (E) {
                    // most probably an unknown charset was used, keep as is
                }

                values.push(parsed.name ? parsed.name + ' <' + parsed.address + '>' : parsed.address);
            });

            if (values.length) {
                headers.update(key, values.join(', '));
            } else {
                headers.remove(key);
            }
        }
    };
}

function convertAddresses(addresses, withNames, addressList) {
    addressList = addressList || new Map();

    flatten(addresses || []).forEach(address => {
        if (address.address) {
            let normalized = normalizeAddress(address, withNames);
            let key = typeof normalized === 'string' ? normalized : normalized.address;
            addressList.set(key, normalized);
        } else if (address.group) {
            convertAddresses(address.group, withNames, addressList);
        }
    });

    return addressList;
}

function parseAddressList(headers, key, withNames) {
    return parseAddressses(headers.getDecoded(key).map(header => header.value), withNames);
}

function parseAddressses(headerList, withNames) {
    let map = convertAddresses(headerList.map(addressparser), withNames);
    return Array.from(map).map(entry => entry[1]);
}

function normalizeAddress(address, withNames) {
    if (!address || !address.address) {
        return '';
    }
    let user = address.address.substr(0, address.address.lastIndexOf('@'));
    let domain = address.address.substr(address.address.lastIndexOf('@') + 1);
    let addr = user.trim() + '@' + punycode.toASCII(domain.toLowerCase().trim());

    if (withNames) {
        return {
            name: address.name || '',
            address: addr
        };
    }

    return addr;
}

// helper function to flatten arrays
function flatten(arr) {
    let flat = [].concat(...arr);
    return flat.some(Array.isArray) ? flatten(flat) : flat;
}
