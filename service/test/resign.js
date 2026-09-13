'use strict';

const JSZip = require('jszip');
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');

const { resign, openPair, deviceOf, devicesOf } = require('../src/install/resign.js');
const pkcs12 = require('../../sdk/pkcs12.js');
const signers = require('../../sdk/test/fixtures/signers.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PASSWORD = 'test-password';

// The devices a pair covers are recorded beside it rather than read out of the certificate, so the
// two committed signers stand in for any pair; only the names change from case to case.
const mint = (...devices) => ({
    author: pkcs12.read(signers.forgeSigner(), PASSWORD),
    distributor: pkcs12.read(signers.forgeSigner(), PASSWORD),
    certDuid: devices[0] || null,
    certDuids: devices
});

const somebodyElse = (...devices) => ({
    author: pkcs12.read(signers.otherSigner(), PASSWORD),
    distributor: pkcs12.read(signers.otherSigner(), PASSWORD),
    certDuid: devices[0] || null,
    certDuids: devices
});

const namesInside = async (archive) => {
    const zip = await JSZip.loadAsync(archive);
    return Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
};

const run = async () => {
    const pair = mint('TESTSET1234');

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

    {
        const theirs = somebodyElse('SOMEONEELSE');
        const { archive: signedForThem } = await resign(fixture.wgt(), theirs);

        const { archive: signedForUs, device } = await resign(signedForThem, pair);
        const names = await namesInside(signedForUs);

        check('a package signed elsewhere is re-signed for this TV', device === 'TESTSET1234', String(device));

        check('the old signature does not survive alongside the new one',
            names.filter((name) => /signature/.test(name)).length === 2,
            names.filter((name) => /signature/.test(name)).join(', '));
    }

    {
        const { archive } = await resign(fixture.wgt(), pair);
        const zip = await JSZip.loadAsync(archive);
        const xml = await zip.files['signature1.xml'].async('string');

        check('the distributor signs the author signature too',
            xml.indexOf('URI="author-signature.xml"') !== -1, 'no reference to the author signature');

        check('every file is referenced',
            xml.indexOf('URI="config.xml"') !== -1, 'config.xml is not referenced');
    }

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

    {
        openPair(pair);
        check('a stored pair reports the device it names', deviceOf(pair) === 'TESTSET1234', String(deviceOf(pair)));
    }

    {
        const many = mint('OTHERSET0001', 'TESTSET1234', 'OTHERSET0002');
        const found = devicesOf(many);

        check('a pair reports every device it names',
            found.join(',') === 'OTHERSET0001,TESTSET1234,OTHERSET0002', found.join(','));

        check('deviceOf still answers with the first of them',
            deviceOf(many) === 'OTHERSET0001', String(deviceOf(many)));

        process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(`${tmpdir()}/homebrew-resign-test-`);
        const config = require('../src/config.js');

        config.update(many);

        check('a TV named among several is allowed to install',
            config.hasCertificates('TESTSET1234') === true, 'a covered TV was refused');

        check('a TV named nowhere in the list is still refused',
            config.hasCertificates('NOTOURS0001') === false, 'an uncovered TV was allowed');

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
