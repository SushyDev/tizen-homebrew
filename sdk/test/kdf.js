'use strict';

const { createHmac } = require('crypto');

const der = require('../der.js');
const signers = require('./fixtures/signers.js');
const { derive, PURPOSE } = require('../kdf.js');
const { suite } = require('./harness.js');

// The MAC on a real PKCS#12 is this derivation and nothing else, so a file that verifies is proof
// the key schedule matches every other implementation's.
const macOf = (bytes) => {
    const pfx = der.children(der.read(bytes));
    const safeBytes = der.bytesOf(der.children(der.children(pfx[1])[1])[0]);
    const macData = der.children(pfx[2]);
    const digestInfo = der.children(macData[0]);

    return {
        stored: der.bytesOf(digestInfo[1]),
        salt: der.bytesOf(macData[1]),
        iterations: der.number(macData[2]),
        safeBytes
    };
};

suite('kdf', (check) => {
    [
        ['a node-forge file', signers.forgeSigner(), signers.FORGE_PASSWORD],
        ['a Tizen Studio file', signers.legacyRc2(), signers.LEGACY_PASSWORD]
    ].forEach(([what, bytes, password]) => {
        const mac = macOf(bytes);
        const key = derive('sha1', password, mac.salt, mac.iterations, PURPOSE.mac, mac.stored.length);
        const computed = createHmac('sha1', key).update(mac.safeBytes).digest();

        check(`the MAC on ${what} verifies`, computed.equals(mac.stored), computed.toString('hex'));
    });

    const salt = Buffer.from('0a58cf64530d823f', 'hex');

    check('the three purposes derive different bytes', (() => {
        const bytes = [PURPOSE.key, PURPOSE.iv, PURPOSE.mac]
            .map((purpose) => derive('sha1', 'smeg', salt, 1, purpose, 8).toString('hex'));

        return new Set(bytes).size === 3;
    })());

    check('a longer request keeps the shorter one as its prefix',
        derive('sha1', 'smeg', salt, 1, PURPOSE.key, 40).subarray(0, 20)
            .equals(derive('sha1', 'smeg', salt, 1, PURPOSE.key, 20)));

    check('more iterations change the answer',
        derive('sha1', 'smeg', salt, 1, PURPOSE.key, 8).toString('hex')
            !== derive('sha1', 'smeg', salt, 2, PURPOSE.key, 8).toString('hex'));

    check('sha256 derives a different key from sha1',
        derive('sha256', 'smeg', salt, 1, PURPOSE.key, 8).toString('hex')
            !== derive('sha1', 'smeg', salt, 1, PURPOSE.key, 8).toString('hex'));
});
