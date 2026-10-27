'use strict';

const test = require('node:test');
const assert = require('node:assert');

let addressTools = require('../lib/address-tools');
let Headers = require('@zone-eu/mailsplit').Headers;

test('#parseAddresses, no names', () => {
    let parsed = addressTools.parseAddresses(['andris1@kreata.ee, <andris2@kreata.ee>, Andris3 <andris3@kreata.ee>', 'Andris4 <andris2@kreata.ee>']);

    assert.deepEqual(['andris1@kreata.ee', 'andris2@kreata.ee', 'andris3@kreata.ee'], parsed);
});

test('#parseAddresses, with names', () => {
    let parsed = addressTools.parseAddresses(['andris1@kreata.ee, <andris2@kreata.ee>, Andris3 <andris3@kreata.ee>', 'Andris4 <andris2@kreata.ee>'], true);

    assert.deepEqual(
        [
            {
                name: '',
                address: 'andris1@kreata.ee'
            },
            {
                name: 'Andris4',
                address: 'andris2@kreata.ee'
            },
            {
                name: 'Andris3',
                address: 'andris3@kreata.ee'
            }
        ],
        parsed
    );
});

test('#parseAddresses, group with names', () => {
    let parsed = addressTools.parseAddresses(
        ['andris1@kreata.ee, Disclosed:<andris2@kreata.ee>, Andris3 <andris3@kreata.ee>;', 'Andris4 <andris2@kreata.ee>'],
        true
    );

    assert.deepEqual(
        [
            {
                name: '',
                address: 'andris1@kreata.ee'
            },
            {
                name: 'Andris4',
                address: 'andris2@kreata.ee'
            },
            {
                name: 'Andris3',
                address: 'andris3@kreata.ee'
            }
        ],
        parsed
    );
});

test('#validateAddress', () => {
    let headers = new Headers([
        {
            key: 'x-prev',
            line: 'X-Prev: previous line'
        },
        {
            key: 'from',
            line: 'From: andris1@kreata.ee, Disclosed:<andris2@kreata.ee>, Andris3 <andris3@kreata.ee>;'
        },
        {
            key: 'x-mid',
            line: 'X-Mid: middle line'
        },
        {
            key: 'from',
            line: 'From: Andris4 <andris2@kreata.ee>'
        },
        {
            key: 'x-next',
            line: 'X-Next: next line'
        }
    ]);

    let parsed = addressTools.validateAddress(headers, 'from');

    assert.deepEqual(parsed.addresses, [
        {
            name: '',
            address: 'andris1@kreata.ee'
        },
        {
            name: 'Andris4',
            address: 'andris2@kreata.ee'
        },
        {
            name: 'Andris3',
            address: 'andris3@kreata.ee'
        }
    ]);

    parsed.set('Juhan Liiv <andris@kreata.ee>');

    assert.deepEqual(headers.getList(), [
        {
            key: 'x-prev',
            line: 'X-Prev: previous line'
        },
        {
            key: 'from',
            line: 'from: Juhan Liiv <andris@kreata.ee>'
        },
        {
            key: 'x-mid',
            line: 'X-Mid: middle line'
        },
        {
            key: 'x-next',
            line: 'X-Next: next line'
        }
    ]);
});

test('#validateAddress, multiple', () => {
    let headers = new Headers([
        {
            key: 'x-prev',
            line: 'X-Prev: previous line'
        },
        {
            key: 'to',
            line: 'To: andris1@kreata.ee, Disclosed:<andris2@kreata.ee>, Andris3 <andris3@kreata.ee>;'
        },
        {
            key: 'x-mid',
            line: 'X-Mid: middle line'
        },
        {
            key: 'to',
            line: 'To: Andris4 <andris2@kreata.ee>'
        },
        {
            key: 'x-next',
            line: 'X-Next: next line'
        }
    ]);

    let parsed = addressTools.validateAddress(headers, 'to');

    assert.deepEqual(parsed.addresses, [
        {
            name: '',
            address: 'andris1@kreata.ee'
        },
        {
            name: 'Andris4',
            address: 'andris2@kreata.ee'
        },
        {
            name: 'Andris3',
            address: 'andris3@kreata.ee'
        }
    ]);

    parsed.set('Juhan Liiv <andris@kreata.ee>, Jõgeva <jogeva@kreata.ee>, andris3@kreata.ee', {
        name: 'Andris3',
        address: 'andris4@kreata.ee'
    });

    assert.deepEqual(headers.getList(), [
        {
            key: 'x-prev',
            line: 'X-Prev: previous line'
        },
        {
            key: 'to',
            line: 'to: Juhan Liiv <andris@kreata.ee>, =?UTF-8?Q?J=C3=B5geva?=\r\n <jogeva@kreata.ee>, andris3@kreata.ee, Andris3 <andris4@kreata.ee>'
        },
        {
            key: 'x-mid',
            line: 'X-Mid: middle line'
        },
        {
            key: 'x-next',
            line: 'X-Next: next line'
        }
    ]);
});

test('#normalizeAddress', () => {
    assert.equal(addressTools.normalizeAddress('safe@jõgeva.ee'), 'safe@xn--jgeva-dua.ee');
    assert.equal(addressTools.normalizeAddress('jõgeva@jõgeva.ee'), 'jõgeva@jõgeva.ee');
    assert.equal(addressTools.normalizeAddress('jõgeva@xn--jgeva-dua.ee'), 'jõgeva@jõgeva.ee');
    assert.equal(addressTools.normalizeAddress('first last@jõgeva.ee'), '"first last"@xn--jgeva-dua.ee');
    assert.equal(addressTools.normalizeAddress('bare-user'), 'bare-user');
});

test('#divideLoad equal', () => {
    let allEqual = [
        {
            id: 1
        },
        {
            id: 2
        },
        {
            id: 3
        },
        {
            id: 3
        }
    ];

    let divided = addressTools.divideLoad(allEqual);

    assert.deepEqual(
        [
            {
                id: 1,
                ratio: 0.25
            },
            {
                id: 2,
                ratio: 0.25
            },
            {
                id: 3,
                ratio: 0.25
            },
            {
                id: 3,
                ratio: 0.25
            }
        ],
        divided
    );
});

test('#divideLoad single half', () => {
    let allEqual = [
        {
            id: 1
        },
        {
            id: 2,
            ratio: 0.5
        },
        {
            id: 3
        }
    ];

    let divided = addressTools.divideLoad(allEqual);

    assert.deepEqual(
        [
            {
                id: 1,
                ratio: 0.25
            },
            {
                id: 2,
                ratio: 0.5
            },
            {
                id: 2,
                ratio: 0.5
            },
            {
                id: 3,
                ratio: 0.25
            }
        ],
        divided
    );
});

test('#divideLoad single small', () => {
    let allEqual = [
        {
            id: 1
        },
        {
            id: 2,
            ratio: 0.1
        },
        {
            id: 3
        },
        {
            id: 4
        }
    ];

    let divided = addressTools.divideLoad(allEqual);

    assert.deepEqual(
        [
            {
                id: 1,
                ratio: 0.3
            },
            {
                id: 1,
                ratio: 0.3
            },
            {
                id: 1,
                ratio: 0.3
            },
            {
                id: 2,
                ratio: 0.1
            },
            {
                id: 3,
                ratio: 0.3
            },
            {
                id: 3,
                ratio: 0.3
            },
            {
                id: 3,
                ratio: 0.3
            },
            {
                id: 4,
                ratio: 0.3
            },
            {
                id: 4,
                ratio: 0.3
            },
            {
                id: 4,
                ratio: 0.3
            }
        ],
        divided
    );
});

test('#divideLoad single result', () => {
    let allEqual = [
        {
            id: 1
        },
        {
            id: 2,
            ratio: 1
        },
        {
            id: 3
        }
    ];

    let divided = addressTools.divideLoad(allEqual);

    assert.deepEqual(
        [
            {
                id: 2,
                ratio: 1
            }
        ],
        divided
    );
});
