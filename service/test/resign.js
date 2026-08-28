'use strict';

// Re-signing, exercised against a real package and a real certificate pair.
//
// Both are made here rather than found: the .wgt comes from fixture.js, and the
// pair is minted in-process with node-forge. Nothing about the signing cares
// whether Samsung issued the certificate — only the television does, later —
// so a self-signed pair proves everything this module is responsible for, and
// proves it without a network, an account, or a set on the desk.

const forge = require('node-forge');
const JSZip = require('jszip');

const { resign, openPair, deviceOf } = require('../src/install/resign.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PASSWORD = 'test-password';

/**
 * A certificate pair naming one device, in the shape config.js stores.
 *
 * 1024-bit keys: this runs on every test invocation and the size proves
 * nothing here — RSA-SHA512 needs 752 bits and the television is not looking.
 */
const mint = (device) => {
    const certificate = (subject) => {
        const keys = forge.pki.rsa.generateKeyPair(1024);
        const cert = forge.pki.createCertificate();

        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + 86400000);

        const name = [{ name: 'commonName', value: subject }];
        cert.setSubject(name);
        cert.setIssuer(name);

        // The device binding, in the place a Samsung distributor certificate
        // carries it: a URI in the subjectAltName.
        cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 6, value: `URN:tizen:deviceid=${device}` }] }]);
        cert.sign(keys.privateKey, forge.md.sha256.create());

        const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSWORD);

        return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary').toString('base64');
    };

    return { authorCert: certificate('test author'), distributorCert: certificate('test distributor'), password: PASSWORD };
};

const namesInside = async (archive) => {
    const zip = await JSZip.loadAsync(archive);
    return Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
};

const run = async () => {
    const pair = mint('TESTSET1234');

    // --- an unsigned package, which is what a build from anywhere else is --
    {
        const before = fixture.wgt();
        const { archive, device, files } = await resign(before, pair);
        const names = await namesInside(archive);

        check('an unsigned package comes back signed',
            names.indexOf('author-signature.xml') !== -1 && names.indexOf('signature1.xml') !== -1,
            names.join(', '));

        check('its contents survive', names.indexOf('config.xml') !== -1, names.join(', '));
        check('and only its contents were digested', files === 1, `digested ${files} files`);
        check('the device is read from the certificate', device === 'TESTSET1234', String(device));
    }

    // --- one signed for somebody else's television ------------------------
    {
        const theirs = mint('SOMEONEELSE');
        const { archive: signedForThem } = await resign(fixture.wgt(), theirs);

        const { archive: signedForUs, device } = await resign(signedForThem, pair);
        const names = await namesInside(signedForUs);

        check('a package signed elsewhere is re-signed for this TV', device === 'TESTSET1234', String(device));

        // The point of dropping the old signatures rather than adding to them:
        // two distributor signatures in one package is not a thing.
        check('the old signature does not survive alongside the new one',
            names.filter((name) => /signature/.test(name)).length === 2,
            names.filter((name) => /signature/.test(name)).join(', '));
    }

    // --- the signature has to cover what is actually in the package -------
    {
        const { archive } = await resign(fixture.wgt(), pair);
        const zip = await JSZip.loadAsync(archive);
        const xml = await zip.files['signature1.xml'].async('string');

        check('the distributor signs the author signature too',
            xml.indexOf('URI="author-signature.xml"') !== -1, 'no reference to the author signature');

        check('every file is referenced',
            xml.indexOf('URI="config.xml"') !== -1, 'config.xml is not referenced');
    }

    // --- and the refusals -------------------------------------------------
    {
        const notAPackage = await resign(Buffer.from('this is not a zip'), pair).catch((e) => e);
        check('junk is refused', notAPackage.code === 'resignFailed', String(notAPackage.code));

        const notAWidget = await resign(fixture.notAPackage(), pair).catch((e) => e);
        check('a zip with no config.xml is refused', notAWidget.code === 'resignFailed', String(notAWidget.code));

        const wrongPassword = await resign(fixture.wgt(), { ...pair, password: 'nope' }).catch((e) => e);
        check('a wrong password is refused', wrongPassword.code === 'resignFailed', String(wrongPassword.code));

        const none = await resign(fixture.wgt(), {}).catch((e) => e);
        check('no certificates at all is refused', none.code === 'resignFailed', String(none.code));
    }

    // --- reading a pair back ----------------------------------------------
    {
        const { distributor } = openPair(pair);
        check('a stored pair reports the device it names', deviceOf(distributor) === 'TESTSET1234', String(deviceOf(distributor)));
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });
