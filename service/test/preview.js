'use strict';

// How a package comes to have a face.
//
// Two halves of one feature. `install/preview.js` opens an archive and reads
// back what the application calls itself, down to the icon the television
// will show — which is what turns `download (2).wgt` in a list into the app
// it actually contains. `install/catalog.js` does the same job for an app
// nobody has downloaded yet, by knowing where its logo lives.
//
// The theme running through every check below is that none of this is allowed
// to be load-bearing. A package with no icon installs. A catalogue entry whose
// repository has no logo.png installs. A file that is not a package at all
// gets refused by the install path, loudly and with a reason — never here, and
// never as a thrown error out of a function whose whole job is to be a
// courtesy. So most of what follows is checking that the answer is `null` and
// not an exception.

const { mkdtempSync, readFileSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const preview = require('../src/install/preview.js');
const { usable, logoFor } = require('../src/install/catalog.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

// --- reading a package ---------------------------------------------------

// What the package under test actually declares.
//
// Read out of the same config.xml the fixture packages, rather than written
// out below as a literal. A literal was there, and it made this suite fail on
// every version bump — which is precisely what a release is: `npm run version
// -- 0.1.1`, commit, tag, and the release build stops on a test about icons.
// The reader is what is being checked here, not the number it happens to find.
const declared = /<widget\b[^>]*\bversion="([^"]*)"/
    .exec(readFileSync(join(__dirname, '..', '..', 'config.xml'), 'utf8'))[1];

{
    // The manifest is deflated in this one and the icon is stored, which is
    // how a packaging tool writes them. That means the walk has to inflate one
    // entry and step over it to reach the other.
    const described = preview.describe(fixture.wgtWithIcon());

    check('a package is read down to its name, version and id',
        described &&
        described.name === 'Tizen Homebrew' &&
        described.version === declared &&
        described.packageId === 'GJBBYNLkgP' &&
        described.appId === 'GJBBYNLkgP.TizenHomebrew',
        JSON.stringify(described && { ...described, icon: null }));

    check('and its icon comes back as a data URI a page can render',
        described && described.icon === `data:image/png;base64,${fixture.PIXEL.toString('base64')}`,
        described && described.icon);
}

{
    // The same package without the picture in it. Every Tizen manifest names
    // an icon; whether the file is actually there is another question, and one
    // that has nothing to do with whether the package installs.
    const described = preview.describe(fixture.wgt());

    check('a package whose icon is missing still describes itself',
        described && described.packageId === 'GJBBYNLkgP' && described.icon === null,
        JSON.stringify(described));
}

{
    const described = preview.describe(fixture.notAPackage());

    check('something that is not a package is null rather than a throw',
        described === null, JSON.stringify(described));
}

{
    // What a head read looks like when the entry it wanted began inside the
    // window and ended outside it — see HEAD in preview.js. Half a PNG is
    // worse than none, so it is refused rather than handed on.
    const cut = fixture.wgtWithIcon().slice(0, 200);

    check('a package cut off partway through is null, not half an icon',
        preview.describe(cut) === null, JSON.stringify(preview.describe(cut)));
}

{
    // An icon far over the cap is dropped and everything around it kept.
    // Pushing a megabyte of artwork down a socket to draw a 40px tile is the
    // one way this whole feature could cost more than it is worth.
    const bloated = fixture.zipAll([
        {
            name: 'config.xml',
            contents: readFileSync(join(__dirname, '..', '..', 'config.xml')),
            deflate: true
        },
        { name: 'icon.png', contents: Buffer.alloc(preview.MAX_ICON + 1, 0x41) }
    ]);

    const described = preview.describe(bloated);

    check('an icon over the cap is dropped, and the identity around it kept',
        described && described.packageId === 'GJBBYNLkgP' && described.icon === null,
        JSON.stringify(described && { ...described, icon: described.icon && 'present' }));
}

// --- reading one off the television's own disk ---------------------------

{
    const directory = mkdtempSync(join(tmpdir(), 'homebrew-preview-'));
    const path = join(directory, 'download (2).wgt');

    writeFileSync(path, fixture.wgtWithIcon());

    const described = preview.describeFile(path);

    check('a package on a stick is read off disk without loading all of it',
        described && described.name === 'Tizen Homebrew' && described.icon !== null,
        JSON.stringify(described && { ...described, icon: 'present' }));

    check('and a path with nothing at it is null rather than a throw',
        preview.describeFile(join(directory, 'absent.wgt')) === null,
        'describeFile should answer for a missing file the same way it answers for a bad one');
}

// --- an app nobody has downloaded yet ------------------------------------

{
    const entry = usable({
        id: 'tube', name: 'YouTube', source: { type: 'github', ref: 'SushyDev/tube' }
    });

    check('a github app is given logo.png in its own repository',
        entry.icon === 'https://raw.githubusercontent.com/SushyDev/tube/HEAD/logo.png', entry.icon);

    const declared = usable({
        id: 'tube', name: 'YouTube', icon: 'https://example.com/tube.png',
        source: { type: 'github', ref: 'SushyDev/tube' }
    });

    check('an entry that names its own icon keeps it',
        declared.icon === 'https://example.com/tube.png', declared.icon);

    const insecure = usable({
        id: 'kodi', name: 'Kodi', icon: 'http://example.com/kodi.png',
        source: { type: 'url', ref: 'https://example.com/Kodi.wgt' }
    });

    check('an http icon is refused, like an http package',
        insecure.icon === null, insecure.icon);

    check('and a url app with no icon named simply has none',
        logoFor({ type: 'url', ref: 'https://example.com/Kodi.wgt' }) === null,
        String(logoFor({ type: 'url', ref: 'https://example.com/Kodi.wgt' })));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
