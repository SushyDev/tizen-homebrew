'use strict';

const { mkdtempSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const JSZip = require('jszip');

const packaging = require('../packaging.js');
const staging = require('../staging.js');
const pkcs12 = require('../pkcs12.js');
const signers = require('./fixtures/signers.js');
const { suite } = require('./harness.js');

const CONFIG = '<?xml version="1.0" encoding="UTF-8"?><widget xmlns="http://www.w3.org/ns/widgets">' +
    '<tizen:application id="ABCDEF1234.Test" package="ABCDEF1234" required_version="6.0"/></widget>';

const staged = () => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-packaging-'));

    mkdirSync(join(root, 'ui', 'dist'), { recursive: true });
    writeFileSync(join(root, 'config.xml'), CONFIG);
    writeFileSync(join(root, 'icon.png'), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(root, 'ui', 'dist', 'index.html'), '<html>hello &amp; goodbye</html>');

    return root;
};

suite('packaging', async (check) => {
    const signer = pkcs12.read(signers.forgeSigner(), signers.FORGE_PASSWORD);
    const pair = { author: signer, distributor: signer };

    const root = staged();
    const files = staging.contentsOf(root);

    check('a directory walks to its files, separators encoded',
        files.map((file) => file.uri).join(',') === 'config.xml,icon.png,ui%2Fdist%2Findex.html',
        files.map((file) => file.uri).join(','));

    check('the walk is sorted, so the same directory builds the same package',
        staging.contentsOf(root).map((file) => file.uri).join(',')
            === files.map((file) => file.uri).join(','));

    const wgt = await packaging.build(files, pair);
    const zip = await JSZip.loadAsync(wgt);

    check('the archive holds the files under their real names',
        Boolean(zip.files['ui/dist/index.html'] && zip.files['config.xml']),
        Object.keys(zip.files).join(','));

    check('the archive holds both signatures',
        Boolean(zip.files['author-signature.xml'] && zip.files['signature1.xml']));

    const report = await packaging.inspect(wgt);

    check('it reads back as signed', report.signed && report.files === 3, JSON.stringify(report.signatures));

    check('every digest it claims still matches',
        report.signatures.every((signature) => signature.mismatched.length === 0),
        JSON.stringify(report.signatures));

    check('the author signature covers the files and the distributor covers one more',
        report.signatures[0].covers === 3 && report.signatures[1].covers === 4,
        report.signatures.map((s) => `${s.name}:${s.covers}`).join(' '));

    check('the certificates that signed it come back out',
        report.certificates.length === 4, report.certificates.length);

    const tampered = await (async () => {
        const opened = await JSZip.loadAsync(wgt);

        return opened.file('config.xml', CONFIG.replace('6.0', '7.0'))
            .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    })();

    check('a file changed after signing is named',
        (await packaging.inspect(tampered)).signatures
            .every((signature) => signature.mismatched.indexOf('config.xml') !== -1));

    const swapped = await (async () => {
        const opened = await JSZip.loadAsync(wgt);
        const xml = await opened.files['author-signature.xml'].async('string');

        return opened.file('author-signature.xml', xml.replace('</Signature>', ' </Signature>'))
            .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    })();

    check('an author signature swapped after the fact is caught by the distributor signature',
        (await packaging.inspect(swapped)).signatures
            .find((signature) => signature.name === 'signature1.xml')
            .mismatched.indexOf('author-signature.xml') !== -1);

    const stripped = await (async () => {
        const opened = await JSZip.loadAsync(wgt);

        return opened.remove('icon.png').generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    })();

    check('a file removed after signing is named as missing',
        (await packaging.inspect(stripped)).signatures
            .every((signature) => signature.missing.indexOf('icon.png') !== -1));

    const again = await packaging.resign(wgt, pair);

    check('re-signing drops the old signatures rather than counting them',
        again.files === 3, again.files);

    check('a re-signed package verifies',
        (await packaging.inspect(again.archive)).signatures
            .every((signature) => signature.mismatched.length === 0));

    check('the ids come out of the manifest', (() => {
        const ids = packaging.idsIn(CONFIG);

        return ids.packageId === 'ABCDEF1234' && ids.appId === 'ABCDEF1234.Test';
    })());

    check('a manifest is read straight out of the archive',
        (await packaging.manifestIn(wgt)).indexOf('tizen:application') !== -1);

    const bare = await new JSZip().file('readme.txt', 'nothing').generateAsync({ type: 'nodebuffer' });

    check('a zip that is not a Tizen package is refused', await (async () => {
        try {
            await packaging.contentsOf(bare);
            return false;
        } catch (error) {
            return error.code === 'packagingFailed';
        }
    })());

    check('something that is not a zip at all is refused', await (async () => {
        try {
            await packaging.contentsOf(Buffer.from('not a zip'));
            return false;
        } catch (error) {
            return error.code === 'packagingFailed';
        }
    })());
});
