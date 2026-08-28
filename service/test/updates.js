'use strict';

// Knowing an update when you see one.
//
// Two things are pinned here. The comparator, because "is this newer" is
// answered with arithmetic on strings somebody typed into a git tag and the
// interesting cases are all the ones that look like they should be obvious —
// 0.10.0 against 0.9.9, a release candidate against its release. And the check
// around it, because the expensive half of it is a request to GitHub per app
// and the rule that keeps it cheap — ask only about what is actually installed
// — is a rule that would break silently.

const versions = require('../src/install/versions.js');
const { createUpdates } = require('../src/install/updates.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

// --- the comparator ------------------------------------------------------
{
    // left, right, and which of them semver says is the greater.
    const CASES = [
        ['0.2.0', '0.1.0', 1],
        ['0.1.0', '0.2.0', -1],
        ['1.0.0', '1.0.0', 0],
        // The one everybody gets wrong by comparing strings.
        ['0.10.0', '0.9.9', 1],
        // A release tag carries a v and a widget version does not, and these
        // two are the same version.
        ['v1.2.0', '1.2.0', 0],
        // A short tag means the zeros it left out.
        ['v1.2', '1.2.0', 0],
        // A prerelease loses to the release it precedes.
        ['1.2.0-rc1', '1.2.0', -1],
        // And prereleases order among themselves numerically, so rc.10 is
        // after rc.2 rather than before it.
        ['1.2.0-rc.10', '1.2.0-rc.2', 1],
        ['1.2.0-alpha', '1.2.0-alpha.1', -1],
        ['1.2.0-1', '1.2.0-alpha', -1],
        // Build metadata takes no part in it.
        ['1.2.0+ci.4', '1.2.0', 0]
    ];

    const wrong = CASES.filter(([left, right, want]) => versions.compare(left, right) !== want);

    check('every version comparison lands the way semver says',
        wrong.length === 0,
        wrong.map(([left, right, want]) =>
            `${left} vs ${right}: ${versions.compare(left, right)}, expected ${want}`).join(' | '));

    // "cannot say" and "the same" are different answers, and an unreadable
    // version quietly meaning "no update" is the failure this prevents.
    check('and a version that is not one compares to nothing',
        versions.compare('1.0.0 (beta)', '1.0.0') === null && versions.compare('', '1.0.0') === null,
        `got ${versions.compare('1.0.0 (beta)', '1.0.0')} and ${versions.compare('', '1.0.0')}`);

    check('so nothing is newer than a version nobody can read',
        versions.isNewer('nightly', '1.0.0') === false && versions.isNewer('2.0.0', 'nightly') === false,
        'an unreadable version was ordered anyway');

    check('a tag reads back as the version in it',
        versions.clean('v1.2.3') === '1.2.3' && versions.clean('nightly') === null,
        `${versions.clean('v1.2.3')} / ${versions.clean('nightly')}`);
}

// --- doubles -------------------------------------------------------------

const CATALOG = [
    { id: 'homebrew', name: 'Tizen Homebrew', version: null, packageId: 'GJBBYNLkgP',
        source: { type: 'github', ref: 'SushyDev/tizen-homebrew' } },
    { id: 'tube', name: 'YouTube', version: null, packageId: 'tUb3Xq7Lm9',
        source: { type: 'github', ref: 'SushyDev/tizen-youtube' } },
    // No package id, so nothing about it can ever be matched to a set.
    { id: 'kodi', name: 'Kodi', version: '21.0', packageId: null,
        source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' } }
];

const fakePackages = (installed) => ({
    list: () => (installed
        ? Promise.resolve(installed)
        : Promise.reject(Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' })))
});

// Counts what it was asked, because the whole cost model rests on it being
// asked as little as possible.
const fakeGitHub = (tags) => {
    const asked = [];

    const latestRelease = (repo) => {
        asked.push(repo);

        return tags[repo]
            ? Promise.resolve({ tag_name: tags[repo] })
            : Promise.reject(Object.assign(new Error(`${repo} has no published releases, or is private.`),
                { code: 'notFound' }));
    };

    return { latestRelease, asked };
};

const marked = (list, id) => (list || []).filter((entry) => entry.id === id)[0];

// --- what it does with them ----------------------------------------------

const run = async () => {
    // A television with the channel on it, one version behind what has been
    // released. This is the case the catalogue entry for Tizen Homebrew exists
    // to produce.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.2.0' });
        const updates = createUpdates({
            packages: fakePackages([{ id: 'GJBBYNLkgP', name: 'Tizen Homebrew', version: '0.1.0' }]),
            latestRelease: github.latestRelease
        });

        const list = await updates.mark(CATALOG);
        const self = marked(list, 'homebrew');

        check('an installed app with a newer release has an update',
            self && self.update === true, JSON.stringify(self));

        check('and carries both versions, so a row can say which replaces which',
            self && self.version === '0.2.0' && self.installed === '0.1.0', JSON.stringify(self));

        // The expensive half. Two of the three entries are github apps and
        // only one of them is on this set.
        check('and only the installed apps cost a request',
            github.asked.length === 1 && github.asked[0] === 'SushyDev/tizen-homebrew',
            github.asked.join(', '));

        check('an app that is not installed is left exactly as the catalogue had it',
            marked(list, 'tube').update === undefined && marked(list, 'kodi').update === undefined,
            JSON.stringify(list));

        // Six hours, and the answer is already in hand.
        await updates.mark(CATALOG);
        check('a second look does not ask again', github.asked.length === 1, github.asked.join(', '));

        // Unless somebody presses refresh, which is what refresh is for.
        await updates.mark(CATALOG, { refresh: true });
        check('and a refresh does', github.asked.length === 2, github.asked.join(', '));
    }

    // The ordinary state of an up-to-date television, and the one that must
    // not offer anything: an update button that reinstalls what is already
    // there is worse than no button.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.1.0' });
        const updates = createUpdates({
            packages: fakePackages([{ id: 'GJBBYNLkgP', version: '0.1.0' }]),
            latestRelease: github.latestRelease
        });

        const self = marked(await updates.mark(CATALOG), 'homebrew');

        check('an app already at the released version has no update',
            self.update === false && self.installed === '0.1.0', JSON.stringify(self));
    }

    // A set running something newer than the release — a hand-pushed build,
    // which is how this app is developed. It is not an update to go backwards.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.1.0' });
        const updates = createUpdates({
            packages: fakePackages([{ id: 'GJBBYNLkgP', version: '0.3.0' }]),
            latestRelease: github.latestRelease
        });

        check('and a set ahead of the release is not offered a downgrade',
            marked(await updates.mark(CATALOG), 'homebrew').update === false, 'offered one anyway');
    }

    // GitHub down, rate-limited, or a repository with nothing published. The
    // list still has to arrive; it just cannot say anything about versions.
    {
        const github = fakeGitHub({});
        const updates = createUpdates({
            packages: fakePackages([{ id: 'GJBBYNLkgP', version: '0.1.0' }]),
            latestRelease: github.latestRelease
        });

        const self = marked(await updates.mark(CATALOG), 'homebrew');

        check('an origin that will not answer costs the mark and nothing else',
            self.update === false && self.installed === '0.1.0', JSON.stringify(self));
    }

    // Off a television — the development harness — nothing is installed, so
    // there is nothing to say and no request worth spending.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v9.0.0' });
        const updates = createUpdates({ packages: fakePackages(null), latestRelease: github.latestRelease });

        const list = await updates.mark(CATALOG);

        check('with nothing installed there is no second answer to send',
            list === null && github.asked.length === 0, `${JSON.stringify(list)} / ${github.asked.join(', ')}`);
    }

    // A `url` app has no releases page to ask, so the catalogue's own version
    // is the only claim there is — and it is still held against the set.
    {
        const github = fakeGitHub({});
        const updates = createUpdates({
            packages: fakePackages([{ id: 'org.xbmc.kodi', version: '20.2' }]),
            latestRelease: github.latestRelease
        });

        const entry = { id: 'kodi', name: 'Kodi', version: '21.0', packageId: 'org.xbmc.kodi',
            source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' } };

        const kodi = marked(await updates.mark([entry]), 'kodi');

        check('a url app is judged on the version the catalogue declares',
            kodi.update === true && github.asked.length === 0, JSON.stringify(kodi));
    }
};

run().then(() => {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
}, (error) => {
    console.error(error);
    process.exit(1);
});
