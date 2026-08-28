'use strict';

// Knowing an update when you see one, and not spending the television's
// request budget to find out.
//
// Three things are pinned here.
//
// The comparator, because "is this newer" is answered with arithmetic on
// strings somebody typed into a git tag, and the interesting cases all look
// like they should be obvious — 0.10.0 against 0.9.9, a release candidate
// against its release.
//
// The free half, because a catalogue of two hundred apps has to draw at the
// speed of a local call and it will not if anything in `mark` reaches the
// network.
//
// And the expensive half, because that is where a big catalogue can hurt
// somebody: it must ask only what it was asked to, a few at a time, and it
// must stop when GitHub says it has had enough rather than spending the rest
// of the list on the same refusal.

const versions = require('../src/install/versions.js');
const { createUpdates, AT_ONCE } = require('../src/install/updates.js');

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
    { id: 'jellyfin', name: 'Jellyfin', version: null, packageId: 'AprZAcqzcc',
        source: { type: 'github', ref: 'jellyfin/jellyfin-tizen' } },
    // Nowhere to ask, so the catalogue's own version is the answer.
    { id: 'kodi', name: 'Kodi', version: '21.0', packageId: 'org.xbmc.kodi',
        source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' } }
];

const INSTALLED = [
    { id: 'GJBBYNLkgP', name: 'Tizen Homebrew', version: '0.1.0' },
    { id: 'tUb3Xq7Lm9', name: 'YouTube', version: '0.1.0' },
    { id: 'org.xbmc.kodi', name: 'Kodi', version: '20.2' }
];

/**
 * A television, and how long it takes to say what is on it.
 *
 * `delay` and `calls` are the point of the whole fake. getPackagesInfo takes
 * six seconds on a full set, and the app list is marked with its answer — so
 * how often this is called, and whether anybody is made to wait for it, is the
 * difference between a list that draws and a list that does not.
 */
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

/**
 * A GitHub that counts what it was asked and how many at once.
 *
 * Both matter: the first is the request budget, and the second is what stops
 * a large catalogue opening a socket per app.
 */
const fakeGitHub = (tags, options = {}) => {
    const asked = [];
    let running = 0;
    let peak = 0;

    const latestRelease = async (repo) => {
        asked.push(repo);
        running += 1;
        peak = Math.max(peak, running);

        try {
            // A tick, so concurrent callers actually overlap.
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

// --- what it does with them ----------------------------------------------

const run = async () => {
    // The free half. A television with three of the four apps on it, and a
    // list that has to arrive without asking anybody anything.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.2.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const list = await updates.mark(CATALOG);

        check('marking the catalogue reaches the network for nothing',
            github.asked.length === 0, github.asked.join(', '));

        check('and still knows what is installed, and at what version',
            of(list, 'homebrew').installed === '0.1.0' && of(list, 'jellyfin').installed === null,
            JSON.stringify(list.map((entry) => [entry.id, entry.installed])));

        // The button is blocked either way, and only this tells the two apart.
        check('an app nobody has asked about is marked unchecked',
            of(list, 'homebrew').checked === false && of(list, 'homebrew').update === false,
            JSON.stringify(of(list, 'homebrew')));

        // Nothing to ask, so it is as checked as it will ever be — and it is
        // still held against the set, which is how a url app offers an update.
        check('an app with nowhere to ask is answered by the catalogue',
            of(list, 'kodi').checked === true && of(list, 'kodi').available === '21.0' &&
            of(list, 'kodi').update === true,
            JSON.stringify(of(list, 'kodi')));
    }

    // The expensive half, one row at a time — which is the whole point of it
    // being a button.
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

        // The version shown beside the name is the one an install would get.
        check('and shows the released version as its own',
            self.version === '0.2.0', String(self.version));

        check('the rows nobody asked about are untouched',
            of(list, 'tube').checked === false && of(list, 'tube').available === null,
            JSON.stringify(of(list, 'tube')));

        // Pressing check on a row you can see means now, not "if you have not
        // already" — the answer in hand may be six hours old.
        await updates.check(CATALOG, { id: 'homebrew' });
        check('and pressing it again asks again', github.asked.length === 2, github.asked.join(', '));
    }

    // The expensive half, all of it.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.2.0', 'SushyDev/tizen-youtube': 'v0.1.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const list = await updates.check(CATALOG);

        check('checking everything asks about every app there is somewhere to ask about',
            github.asked.length === 3 && github.asked.indexOf('https://example.invalid/Kodi.wgt') === -1,
            github.asked.join(', '));

        // Above one proves the pool actually runs them together; at or below
        // the limit proves it is a pool at all rather than a Promise.all with
        // a comment on it.
        check('a few at a time, and never more than a few',
            github.peak() > 1 && github.peak() <= AT_ONCE,
            `${github.peak()} at once, limit ${AT_ONCE}`);

        check('an installed app already at the released version offers nothing',
            of(list, 'tube').checked === true && of(list, 'tube').update === false,
            JSON.stringify(of(list, 'tube')));

        // Asked, and told nothing. The row has to be able to say so rather
        // than look like one nobody has asked about yet.
        check('an app with no releases is checked and empty, not unchecked',
            of(list, 'jellyfin').checked === true && of(list, 'jellyfin').available === null,
            JSON.stringify(of(list, 'jellyfin')));

        // Six hours, and there is nothing left to ask.
        await updates.check(CATALOG);
        check('a second check all spends nothing', github.asked.length === 3, github.asked.join(', '));

        // And the answers survive into an ordinary catalogue send.
        const marked = await updates.mark(CATALOG);
        check('and the answers are still on the list next time it is sent',
            of(marked, 'homebrew').update === true && github.asked.length === 3,
            JSON.stringify(of(marked, 'homebrew')));
    }

    // A set ahead of the release — a hand-pushed build, which is how this app
    // is developed. It is not an update to go backwards.
    {
        const github = fakeGitHub({ 'SushyDev/tizen-homebrew': 'v0.1.0' });
        const updates = createUpdates({
            packages: fakePackages([{ id: 'GJBBYNLkgP', version: '0.3.0' }]),
            latestRelease: github.latestRelease
        });

        check('a set ahead of the release is not offered a downgrade',
            of(await updates.check(CATALOG), 'homebrew').update === false, 'offered one anyway');
    }

    // An app that is not installed cannot have an update, however new the
    // release is — there is nothing to update.
    {
        const github = fakeGitHub({ 'jellyfin/jellyfin-tizen': 'v99.0.0' });
        const updates = createUpdates({ packages: fakePackages(INSTALLED), latestRelease: github.latestRelease });

        const jellyfin = of(await updates.check(CATALOG, { id: 'jellyfin' }), 'jellyfin');

        check('an app that is not here installs rather than updates',
            jellyfin.installed === null && jellyfin.update === false && jellyfin.available === '99.0.0',
            JSON.stringify(jellyfin));
    }

    // Sixty an hour, and a big catalogue can spend them. The run stops on the
    // first refusal rather than spending what is left of the list proving the
    // same point.
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

    // --- the set's own listing, which is not free ------------------------
    //
    // These pin the fix for the bug that made the app list "unreliable": every
    // catalogue sent to a phone was awaited on a six-second getPackagesInfo,
    // and most phone sessions are shorter than six seconds, so the frame was
    // written to a socket that had already gone.
    {
        const tv = fakePackages(INSTALLED, 40);
        const updates = createUpdates({ packages: tv, latestRelease: fakeGitHub({}).latestRelease });

        // The first read has nothing to go on and must wait for the real answer.
        const first = await updates.mark(CATALOG);

        check('the first marking asks the set what it is holding',
            tv.calls === 1 && of(first, 'homebrew').installed === '0.1.0',
            `${tv.calls} calls, ${JSON.stringify(of(first, 'homebrew'))}`);

        // Every read after it is served from what was kept. This is the one
        // that matters: it is the difference between a list that arrives now
        // and a list that arrives after the phone has gone.
        const began = Date.now();
        const again = await updates.mark(CATALOG);
        const waited = Date.now() - began;

        check('and every marking after it is answered without asking again',
            tv.calls === 1 && waited < 20 && of(again, 'homebrew').installed === '0.1.0',
            `${tv.calls} calls, waited ${waited}ms`);

        // Three phones asking at once is in the log this was found in, and
        // three overlapping six-second calls is what it used to cost.
        const busyTv = fakePackages(INSTALLED, 40);
        const busy = createUpdates({ packages: busyTv, latestRelease: fakeGitHub({}).latestRelease });

        const together = await Promise.all([busy.mark(CATALOG), busy.mark(CATALOG), busy.mark(CATALOG)]);

        check('phones arriving together share one listing rather than starting three',
            busyTv.calls === 1 && together.every((one) => of(one, 'homebrew').installed === '0.1.0'),
            `${busyTv.calls} calls`);
    }

    {
        // Priming is the whole reason the first phone does not pay: startup
        // asks with nobody waiting, and the listing is there by the time one
        // connects.
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
        // An install changes what the set is holding, and the next list has to
        // say so — but it still must not block while finding out.
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
        // A set that will not answer costs the version marks and nothing else
        // — it must never be the reason a catalogue fails to arrive.
        const refusing = {
            calls: 0,
            list: () => {
                refusing.calls += 1;
                return Promise.reject(Object.assign(new Error('getPackagesInfo timed out'), { code: 'internal' }));
            }
        };

        const updates = createUpdates({ packages: refusing, latestRelease: fakeGitHub({}).latestRelease });
        const list = await updates.mark(CATALOG);

        check('a television that will not list still produces a catalogue',
            list.length === CATALOG.length && list.every((entry) => entry.installed === null),
            JSON.stringify(list.map((entry) => [entry.id, entry.installed])));
    }

    // Off a television — the development harness — nothing is installed, and
    // a check still works and still costs what it costs.
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
