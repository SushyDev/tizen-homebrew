'use strict';

const versions = require('../src/install/versions.js');
const { createUpdates, AT_ONCE } = require('../src/install/updates.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

{
    const CASES = [
        ['0.2.0', '0.1.0', 1],
        ['0.1.0', '0.2.0', -1],
        ['1.0.0', '1.0.0', 0],
        ['0.10.0', '0.9.9', 1],
        ['v1.2.0', '1.2.0', 0],
        ['v1.2', '1.2.0', 0],
        ['1.2.0-rc1', '1.2.0', -1],
        ['1.2.0-rc.10', '1.2.0-rc.2', 1],
        ['1.2.0-alpha', '1.2.0-alpha.1', -1],
        ['1.2.0-1', '1.2.0-alpha', -1],
        ['1.2.0+ci.4', '1.2.0', 0]
    ];

    const wrong = CASES.filter(([left, right, want]) => versions.compare(left, right) !== want);

    check('every version comparison lands the way semver says',
        wrong.length === 0,
        wrong.map(([left, right, want]) =>
            `${left} vs ${right}: ${versions.compare(left, right)}, expected ${want}`).join(' | '));

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

const CATALOG = [
    { id: 'homebrew', name: 'Tizen Homebrew', version: null, packageId: 'GJBBYNLkgP',
        source: { type: 'github', ref: 'SushyDev/tizen-homebrew' } },
    { id: 'tube', name: 'YouTube', version: null, packageId: 'tUb3Xq7Lm9',
        source: { type: 'github', ref: 'SushyDev/tizen-youtube' } },
    { id: 'jellyfin', name: 'Jellyfin', version: null, packageId: 'AprZAcqzcc',
        source: { type: 'github', ref: 'jellyfin/jellyfin-tizen' } },
    { id: 'kodi', name: 'Kodi', version: '21.0', packageId: 'org.xbmc.kodi',
        source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' } }
];

const INSTALLED = [
    { id: 'GJBBYNLkgP', name: 'Tizen Homebrew', version: '0.1.0' },
    { id: 'tUb3Xq7Lm9', name: 'YouTube', version: '0.1.0' },
    { id: 'org.xbmc.kodi', name: 'Kodi', version: '20.2' }
];

const fakePackages = (installed, delay = 0) => {
    const fake = {
        calls: 0,
        list: () => {
            fake.calls += 1;

            if (!installed) {
                return Promise.reject(Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' }));
            }

            return new Promise((resolve) => setTimeout(() => resolve(installed), delay));
        }
    };

    return fake;
};

const fakeGitHub = (tags, options = {}) => {
    const asked = [];
    let running = 0;
    let peak = 0;

    const latestRelease = async (repo) => {
        asked.push(repo);
        running += 1;
        peak = Math.max(peak, running);

        try {
            await new Promise((resolve) => setTimeout(resolve, 5));

            if (options.refusing) {
                throw Object.assign(new Error(`${repo} returned 403`), { code: 'downloadFailed', status: 403 });
            }

            if (!tags[repo]) {
                throw Object.assign(new Error(`${repo} has no published releases, or is private.`),
                    { code: 'notFound', status: 404 });
            }

            return { tag_name: tags[repo] };
        } finally {
            running -= 1;
        }
    };

    return { latestRelease, asked, peak: () => peak };
};

const of = (list, id) => (list || []).filter((entry) => entry.id === id)[0];

const run = async () => {
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.2.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const list = await updates.mark(CATALOG);

        check('marking the catalog reaches the network for nothing',
            github.asked.length === 0, github.asked.join(', '));

        check('and still knows what is installed, and at what version',
            of(list, 'homebrew').installed === '0.1.0' && of(list, 'jellyfin').installed === null,
            JSON.stringify(list.map((entry) => [entry.id, entry.installed])));

        check('an app nobody has asked about is marked unchecked',
            of(list, 'homebrew').checked === false && of(list, 'homebrew').update === false,
            JSON.stringify(of(list, 'homebrew')));

        check('an app with nowhere to ask is answered by the catalog',
            of(list, 'kodi').checked === true && of(list, 'kodi').available === '21.0' &&
            of(list, 'kodi').update === true,
            JSON.stringify(of(list, 'kodi')));
    }

    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.2.0', 'SushyDev/tizen-youtube': 'v0.1.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const list = await updates.check(CATALOG, { id: 'homebrew' });

        check('checking one app asks about exactly that one',
            github.asked.length === 1 && github.asked[0] === 'SushyDev/tizen-homebrew',
            github.asked.join(', '));

        const self = of(list, 'homebrew');

        check('and it comes back with both versions and an update',
            self.checked === true && self.installed === '0.1.0' &&
            self.available === '0.2.0' && self.update === true,
            JSON.stringify(self));

        check('and shows the released version as its own',
            self.version === '0.2.0', String(self.version));

        check('the rows nobody asked about are untouched',
            of(list, 'tube').checked === false && of(list, 'tube').available === null,
            JSON.stringify(of(list, 'tube')));

        await updates.check(CATALOG, { id: 'homebrew' });
        check('and pressing it again asks again', github.asked.length === 2, github.asked.join(', '));
    }

    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.2.0', 'SushyDev/tizen-youtube': 'v0.1.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const list = await updates.check(CATALOG);

        check('checking everything asks about every app there is somewhere to ask about',
            github.asked.length === 3 && github.asked.indexOf('https://example.invalid/Kodi.wgt') === -1,
            github.asked.join(', '));

        check('a few at a time, and never more than a few',
            github.peak() > 1 && github.peak() <= AT_ONCE,
            `${github.peak()} at once, limit ${AT_ONCE}`);

        check('an installed app already at the released version offers nothing',
            of(list, 'tube').checked === true && of(list, 'tube').update === false,
            JSON.stringify(of(list, 'tube')));

        check('an app with no releases is checked and empty, not unchecked',
            of(list, 'jellyfin').checked === true && of(list, 'jellyfin').available === null,
            JSON.stringify(of(list, 'jellyfin')));

        await updates.check(CATALOG);
        check('a second check all spends nothing', github.asked.length === 3, github.asked.join(', '));

        const marked = await updates.mark(CATALOG);
        check('and the answers are still on the list next time it is sent',
            of(marked, 'homebrew').update === true && github.asked.length === 3,
            JSON.stringify(of(marked, 'homebrew')));
    }

    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.1.0' });
        const updates = createUpdates({
            packages: fakePackages([{ id: 'GJBBYNLkgP', version: '0.3.0' }]),
            latestRelease: github.latestRelease
        });

        check('a set ahead of the release is not offered a downgrade',
            of(await updates.check(CATALOG), 'homebrew').update === false, 'offered one anyway');
    }

    {
        const github = fakeGitHub({ 'jellyfin/jellyfin-tizen': 'v99.0.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const jellyfin = of(await updates.check(CATALOG, { id: 'jellyfin' }), 'jellyfin');

        check('an app that is not here installs rather than updates',
            jellyfin.installed === null && jellyfin.update === false && jellyfin.available === '99.0.0',
            JSON.stringify(jellyfin));
    }

    {
        const github = fakeGitHub({}, { refusing: true });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const list = await updates.check(CATALOG);

        check('a rate-limited television stops asking',
            github.asked.length <= AT_ONCE, `${github.asked.length} asked before stopping`);

        check('and the list still comes back, just without the answers',
            list.length === CATALOG.length && of(list, 'homebrew').update === false,
            JSON.stringify(list.map((entry) => [entry.id, entry.checked])));
    }

    {
        const tv = fakePackages(INSTALLED, 40);
        const updates = createUpdates({ packages: tv, latestRelease: fakeGitHub({}).latestRelease });

        const first = await updates.mark(CATALOG);

        check('the first marking asks the set what it is holding',
            tv.calls === 1 && of(first, 'homebrew').installed === '0.1.0',
            `${tv.calls} calls, ${JSON.stringify(of(first, 'homebrew'))}`);

        const began = Date.now();
        const again = await updates.mark(CATALOG);
        const waited = Date.now() - began;

        check('and every marking after it is answered without asking again',
            tv.calls === 1 && waited < 20 && of(again, 'homebrew').installed === '0.1.0',
            `${tv.calls} calls, waited ${waited}ms`);

        const busyTv = fakePackages(INSTALLED, 40);
        const busy = createUpdates({ packages: busyTv, latestRelease: fakeGitHub({}).latestRelease });

        const together = await Promise.all([busy.mark(CATALOG), busy.mark(CATALOG), busy.mark(CATALOG)]);

        check('phones arriving together share one listing rather than starting three',
            busyTv.calls === 1 && together.every((one) => of(one, 'homebrew').installed === '0.1.0'),
            `${busyTv.calls} calls`);
    }

    {
        const tv = fakePackages(INSTALLED, 40);
        const updates = createUpdates({ packages: tv, latestRelease: fakeGitHub({}).latestRelease });

        updates.prime();
        await new Promise((resolve) => setTimeout(resolve, 60));

        const began = Date.now();
        const list = await updates.mark(CATALOG);
        const waited = Date.now() - began;

        check('a primed listing means the first phone waits for nothing',
            tv.calls === 1 && waited < 20 && of(list, 'homebrew').installed === '0.1.0',
            `${tv.calls} calls, waited ${waited}ms`);
    }

    {
        const tv = fakePackages(INSTALLED, 40);
        const updates = createUpdates({ packages: tv, latestRelease: fakeGitHub({}).latestRelease });

        await updates.mark(CATALOG);
        updates.changed();

        const began = Date.now();
        await updates.mark(CATALOG);
        const waited = Date.now() - began;

        check('an install re-asks the set without making the next list wait',
            tv.calls === 2 && waited < 20,
            `${tv.calls} calls, waited ${waited}ms`);
    }

    {
        const refusing = {
            calls: 0,
            list: () => {
                refusing.calls += 1;
                return Promise.reject(Object.assign(new Error('getPackagesInfo timed out'), { code: 'internal' }));
            }
        };

        const updates = createUpdates({ packages: refusing, latestRelease: fakeGitHub({}).latestRelease });
        const list = await updates.mark(CATALOG);

        check('a television that will not list still produces a catalog',
            list.length === CATALOG.length && list.every((entry) => entry.installed === null),
            JSON.stringify(list.map((entry) => [entry.id, entry.installed])));
    }

    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v9.0.0' });
        const updates = createUpdates({ packages: fakePackages(null), latestRelease: github.latestRelease });

        const list = await updates.mark(CATALOG);

        check('with no television there is nothing installed and nothing asked',
            list.every((entry) => entry.installed === null) && github.asked.length === 0,
            github.asked.join(', '));
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
