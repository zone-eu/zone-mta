'use strict';

let addressTools = require('../lib/address-tools');
let Headers = require('mailsplit').Headers;

module.exports['#parseAddressses, no names'] = test => {
    let parsed = addressTools.parseAddressses(['andris1@kreata.ee, <andris2@kreata.ee>, Andris3 <andris3@kreata.ee>', 'Andris4 <andris2@kreata.ee>']);

    test.deepEqual(['andris1@kreata.ee', 'andris2@kreata.ee', 'andris3@kreata.ee'], parsed);

    test.done();
};

module.exports['#parseAddressses, with names'] = test => {
    let parsed = addressTools.parseAddressses(['andris1@kreata.ee, <andris2@kreata.ee>, Andris3 <andris3@kreata.ee>', 'Andris4 <andris2@kreata.ee>'], true);

    test.deepEqual(
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

    test.done();
};

module.exports['#parseAddressses, group with names'] = test => {
    let parsed = addressTools.parseAddressses(
        ['andris1@kreata.ee, Disclosed:<andris2@kreata.ee>, Andris3 <andris3@kreata.ee>;', 'Andris4 <andris2@kreata.ee>'],
        true
    );

    test.deepEqual(
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

    test.done();
};

module.exports['#validateAddress'] = test => {
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

    test.deepEqual(parsed.addresses, [
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

    test.deepEqual(headers.getList(), [
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

    test.done();
};

module.exports['#validateAddress, multiple'] = test => {
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

    test.deepEqual(parsed.addresses, [
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

    test.deepEqual(headers.getList(), [
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

    test.done();
};

module.exports['#divideLoad equal'] = test => {
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

    test.deepEqual(
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

    test.done();
};

module.exports['#divideLoad single half'] = test => {
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

    test.deepEqual(
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

    test.done();
};

module.exports['#divideLoad single small'] = test => {
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

    test.deepEqual(
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

    test.done();
};

module.exports['#divideLoad single result'] = test => {
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

    test.deepEqual(
        [
            {
                id: 2,
                ratio: 1
            }
        ],
        divided
    );

    test.done();
};
