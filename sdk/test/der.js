'use strict';

const der = require('../der.js');
const { suite } = require('./harness.js');

suite('der', (check) => {
    const encoded = der.sequence([
        der.oid('1.2.840.113549.1.12.1.3'),
        der.integer(2048),
        der.octets(Buffer.from('abc'))
    ]);

    const parts = der.children(der.read(encoded));

    check('an OID survives the round trip', der.dotted(parts[0]) === '1.2.840.113549.1.12.1.3', der.dotted(parts[0]));
    check('an integer survives the round trip', der.number(parts[1]) === 2048, der.number(parts[1]));
    check('an octet string survives the round trip', der.bytesOf(parts[2]).toString() === 'abc');

    check('a length over 127 bytes uses the long form',
        der.read(der.octets(Buffer.alloc(300))).contents.length === 300);

    check('an integer whose top bit is set gains a zero byte',
        der.integer(255).equals(Buffer.from('020200ff', 'hex')), der.integer(255).toString('hex'));

    check('zero encodes as one byte', der.integer(0).equals(Buffer.from('020100', 'hex')));

    check('a BMPString is UTF-16 big-endian',
        der.bmp('hi').equals(Buffer.from('1e0400680069', 'hex')), der.bmp('hi').toString('hex'));

    check('a context tag is constructed when it holds values',
        der.explicit(0, [der.nul()])[0] === 0xa0);

    check('an implicit context tag is primitive',
        der.implicit(6, Buffer.from('x'))[0] === 0x86);

    // BER: a constructed value may declare no length and end with two zero bytes instead.
    const indefinite = Buffer.concat([
        Buffer.from([0x30, 0x80]),
        der.integer(1),
        der.integer(2),
        Buffer.from([0x00, 0x00])
    ]);

    const inside = der.children(der.read(indefinite));

    check('an indefinite length is read to its terminator',
        inside.length === 2 && der.number(inside[0]) === 1 && der.number(inside[1]) === 2,
        inside.length);

    // A BER octet string may arrive in constructed pieces.
    const split = Buffer.concat([
        Buffer.from([0x24, 0x80]),
        der.octets(Buffer.from('ab')),
        der.octets(Buffer.from('cd')),
        Buffer.from([0x00, 0x00])
    ]);

    check('a split octet string reads as one value',
        der.bytesOf(der.read(split)).toString() === 'abcd', der.bytesOf(der.read(split)).toString());

    check('a value that runs past the end is refused', (() => {
        try {
            der.read(Buffer.from([0x30, 0x7f, 0x01]));
            return false;
        } catch (error) {
            return error.code === 'derMalformed';
        }
    })());
});
