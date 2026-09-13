'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { createPrivateKey, generateKeyPairSync } = require('crypto');

const pkcs12 = require('../pkcs12.js');
const signers = require('./fixtures/signers.js');
const { suite } = require('./harness.js');

const normalise = (pem) => createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' });

suite('pkcs12', (check) => {
    // Written by node-forge, which is what every pair minted before this was written looks like.
    const forged = pkcs12.read(signers.forgeSigner(), signers.FORGE_PASSWORD);

    check('a node-forge file opens', forged.certificates.length === 2 && Boolean(forged.key),
        forged.certificates.length);

    check('the certificates come out leaf first, in chain order',
        forged.certificates.join('').replace(/\s/g, '')
            === readFileSync(join(__dirname, 'fixtures', 'forge-signer.pem'), 'utf8').replace(/\s/g, ''));

    // Written by OpenSSL the way Tizen Studio writes one: RC2-40 around the certificates and
    // PBE-SHA1-3DES around the key.
    const legacy = pkcs12.read(signers.legacyRc2(), signers.LEGACY_PASSWORD);

    check('a Tizen Studio file opens, RC2 certificate bags and all',
        legacy.certificates.length === 2 && Boolean(legacy.key), legacy.certificates.length);

    check('both files hold the same key',
        normalise(legacy.key) === normalise(forged.key));

    const written = pkcs12.write({
        certificates: forged.certificates,
        key: forged.key,
        password: 'round-trip'
    });

    const back = pkcs12.read(written, 'round-trip');

    check('what it writes, it reads',
        JSON.stringify(back.certificates) === JSON.stringify(forged.certificates)
            && normalise(back.key) === normalise(forged.key));

    check('a wrong password is refused by name', (() => {
        try {
            pkcs12.read(written, 'not-the-password');
            return false;
        } catch (error) {
            return error.code === 'pkcs12Failed' && /password/.test(error.message);
        }
    })());

    check('a file that is not a PKCS#12 is refused', (() => {
        try {
            pkcs12.read(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]), 'x');
            return false;
        } catch (error) {
            return error.code === 'pkcs12Failed' || error.code === 'derMalformed';
        }
    })());

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    check('a key that does not belong to the certificate still round-trips', (() => {
        const other = pkcs12.write({
            certificates: [forged.certificates[0]],
            key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
            password: 'x'
        });

        return pkcs12.read(other, 'x').certificates.length === 1;
    })());
});
