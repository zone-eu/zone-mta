'use strict';

module.exports = {
    ENODATA: 'DNS server returned answer with no data',
    EFORMERR: 'DNS server claims query was misformatted',
    ESERVFAIL: 'DNS server returned general failure',
    ENOTFOUND: 'Domain name not found',
    ENOTIMP: 'DNS server does not implement requested operation',
    EREFUSED: 'DNS server refused query',
    EBADQUERY: 'Misformatted DNS query',
    EBADNAME: 'Misformatted hostname',
    EBADFAMILY: 'Unsupported address family',
    EBADRESP: 'Misformatted DNS reply',
    ECONNREFUSED: 'Could not contact DNS servers',
    ETIMEOUT: 'Timeout while contacting DNS servers',
    EEOF: 'End of file',
    EFILE: 'Error reading file',
    ENOMEM: 'Out of memory',
    EDESTRUCTION: 'Channel is being destroyed',
    EBADSTR: 'Misformatted string',
    EBADFLAGS: 'Illegal flags specified',
    ENONAME: 'Given hostname is not numeric',
    EBADHINTS: 'Illegal hints flags specified',
    ENOTINITIALIZED: 'c-ares library initialization not yet performed',
    ELOADIPHLPAPI: 'Error loading iphlpapi.dll',
    EADDRGETNETWORKPARAMS: 'Could not find GetNetworkParams function',
    ECANCELLED: 'DNS query cancelled'
};
