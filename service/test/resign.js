'use strict';

// Re-signing, exercised against a real package and a real certificate pair.
//
// Both are made here rather than found: the .wgt comes from fixture.js, and the
// pair is minted in-process with node-forge and converted the way `npm run
// certs` converts it. Nothing about the signing cares whether Samsung issued the
// certificate — only the television does, later.

const forge = require('node-forge');
const JSZip = require('jszip');
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');

const { resign, openPair, deviceOf, devicesOf } = require('../src/install/resign.js');
const { asPem } = require('../../tools/certificates.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PASSWORD = 'test-password';

/**
 * A certificate pair naming one or more devices, in the shape config.js stores.
 *
 * Several, because Samsung's `--duidList` takes a list and one pair covering
 * every television you own is the supported arrangement, not an oddity.
 *
 * 1024-bit keys: this runs on every test invocation and the size proves
 * nothing here — RSA-SHA512 needs 752 bits and the television is not looking.
 */
const mint = (...devices) => {
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
        cert.setExtensions([{
            name: 'subjectAltName',
            altNames: devices.map((device) => ({ type: 6, value: `URN:tizen:deviceid=${device}` }))
        }]);
        cert.sign(keys.privateKey, forge.md.sha256.create());

        const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSWORD);

        return asPem(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'), PASSWORD);
    };

    return {
        author: certificate('test author'),
        distributor: certificate('test distributor'),
        certDuid: devices[0] || null,
        certDuids: devices
    };
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
        check('the device comes back with the signed package', device === 'TESTSET1234', String(device));
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

        const damaged = await resign(fixture.wgt(), { ...pair, distributor: { certificates: ['nonsense'], key: 'nonsense' } })
            .catch((e) => e);
        check('a damaged half is refused', damaged.code === 'resignFailed', String(damaged.code));

        const none = await resign(fixture.wgt(), {}).catch((e) => e);
        check('no certificates at all is refused', none.code === 'resignFailed', String(none.code));
    }

    // --- reading a pair back ----------------------------------------------
    {
        openPair(pair);
        check('a stored pair reports the device it names', deviceOf(pair) === 'TESTSET1234', String(deviceOf(pair)));
    }

    // --- a pair that names several televisions -----------------------------
    //
    // The regression this guards: reading only the first entry of a --duidList
    // made a certificate that legitimately covers this TV look like one minted
    // for somebody else's, and installs were refused on the strength of it.
    {
        const many = mint('OTHERSET0001', 'TESTSET1234', 'OTHERSET0002');
        const found = devicesOf(many);

        check('a pair reports every device it names',
            found.join(',') === 'OTHERSET0001,TESTSET1234,OTHERSET0002', found.join(','));

        check('deviceOf still answers with the first of them',
            deviceOf(many) === 'OTHERSET0001', String(deviceOf(many)));

        // The place the wrong answer actually cost something: config.js decides
        // whether an install may proceed on this television.
        process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(`${tmpdir()}/homebrew-resign-test-`);
        const config = require('../src/config.js');

        config.update(many);

        check('a TV named among several is allowed to install',
            config.hasCertificates('TESTSET1234') === true, 'a covered TV was refused');

        check('a TV named nowhere in the list is still refused',
            config.hasCertificates('NOTOURS0001') === false, 'an uncovered TV was allowed');

        // A config written before certDuids existed carries only the one name.
        config.update({ certDuids: null, certDuid: 'TESTSET1234' });

        check('an older config with a single name still works',
            config.hasCertificates('TESTSET1234') === true && config.hasCertificates('NOTOURS0001') === false,
            'the single-name fallback broke');

        config.clear();
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });
