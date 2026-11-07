'use strict';

const { mkdtempSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const zip = require('../src/install/zip.js');
const manifest = require('../src/install/manifest.js');
const preview = require('../src/install/preview.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const attempt = (fn) => {
    try {
        return { value: fn() };
    } catch (error) {
        return { error };
    }
};

{
    const plain = fixture.wgtWithIcon();
    const streamed = fixture.streamedWgt();

    const a = attempt(() => manifest.identify(plain));
    const b = attempt(() => manifest.identify(streamed));

    check('a package with sizes in its local headers identifies',
        a.value && a.value.packageId === 'GJBBYNLkgP', a.error && a.error.message);

    check('and so does one written with data descriptors, which read as "unexpected end of file" before',
        b.value && b.value.packageId === 'GJBBYNLkgP' && b.value.version === a.value.version,
        b.error ? b.error.message : JSON.stringify(b.value));

    check('the icon comes out of a descriptor-style package intact',
        zip.read(zip.fromBuffer(streamed), 'icon.png').equals(fixture.PIXEL), 'icon bytes differ');

    check('the central directory lists every entry in order',
        JSON.stringify(zip.names(zip.fromBuffer(streamed))) === JSON.stringify(['NOTICES.txt', 'config.xml', 'icon.png']),
        JSON.stringify(zip.names(zip.fromBuffer(streamed))));
}

{
    // Only the front of the archive, the way a head-only read sees it: no central directory to ask.
    const streamed = fixture.streamedWgt({ filler: 4096 });
    const head = streamed.slice(0, streamed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));

    const found = attempt(() => manifest.identify(head));

    check('with no central directory the local headers are walked, descriptors and all',
        found.value && found.value.packageId === 'GJBBYNLkgP', found.error ? found.error.message : JSON.stringify(found.value));

    check('and an entry the head stops short of is absent rather than garbage',
        zip.read(zip.fromBuffer(streamed.slice(0, 120)), 'config.xml') === null, 'read something out of 120 bytes');
}

{
    // A stray descriptor signature inside data must not be believed: its recorded size will not match.
    const decoy = Buffer.concat([Buffer.from('PK\u0007\u0008', 'binary'), Buffer.alloc(64, 0x41)]);
    const archive = fixture.zipAll([
        { name: 'decoy.bin', contents: decoy },
        { name: 'config.xml', contents: require('fs').readFileSync(join(__dirname, '..', '..', 'config.xml')) }
    ], { descriptor: true });

    // Everything up to the central directory: the local headers and their descriptors, whole.
    const head = archive.slice(0, archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
    const found = attempt(() => manifest.identify(head));

    check('a descriptor signature inside stored data is not mistaken for the end of the entry',
        found.value && found.value.packageId === 'GJBBYNLkgP', found.error ? found.error.message : JSON.stringify(found.value));
}

{
    const directory = mkdtempSync(join(tmpdir(), 'homebrew-zip-'));
    const path = join(directory, 'Bravo.wgt');

    // Past the 2MB a head-only preview reads, which is where Bravo keeps its manifest.
    writeFileSync(path, fixture.streamedWgt({ filler: preview.HEAD + 1024 }));

    const described = preview.describeFile(path);

    check('a package on a stick whose manifest is past the first 2MB is still described',
        described && described.packageId === 'GJBBYNLkgP' && described.icon !== null,
        JSON.stringify(described && { ...described, icon: described.icon && 'present' }));
}

{
    const truncated = fixture.streamedWgt().slice(0, 40);

    check('something too short to be a zip is null, not a throw',
        attempt(() => zip.read(zip.fromBuffer(truncated), 'config.xml')).value === null, 'threw or found something');

    const empty = attempt(() => zip.read(zip.fromBuffer(Buffer.alloc(0)), 'config.xml'));

    check('and so is nothing at all', empty.value === null, empty.error && empty.error.message);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
