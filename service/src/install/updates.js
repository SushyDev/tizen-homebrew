'use strict';

// What the television already has, and what the catalogue could give it.
//
// Two questions, and they cost wildly different amounts to answer.
//
// *What is installed* comes from the platform's own package list: one local
// call, no network, and the answer covers every app at once. It reads like a
// free call and it is not — see `holding` below, which is why the answer is
// kept rather than asked for on the way to every screen.
//
// *What has been released* is one HTTP request per app, to a GitHub API that
// allows an unauthenticated caller sixty an hour. On a catalogue of five apps
// that is nothing; on a catalogue of two hundred it is a rate limit and a long
// wait, for a list somebody opened to look at. So it is never done on the way
// to drawing the screen. It happens when somebody asks — one row, or all of
// them — and the answers are remembered for six hours.
//
// The split is the whole design: the free half is automatic and the expensive
// half is a button.

const sources = require('./sources.js');
const versions = require('./versions.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

// How long a listing of what the television is holding is treated as current.
//
// Short, because the cost of it being wrong is a row that says "install" next
// to an app somebody installed a moment ago from the TV's own menus. This
// service is told about the installs it performs itself — `changed()` — so
// the timer is only a backstop for the ones it does not perform.
const INSTALLED_TTL = 60 * 1000;

// Above this, listing the set is worth a line in the log rather than a debug
// record. A television that takes seconds to say what is on it is the whole
// reason the listing is cached, and the number belongs where somebody reading
// a slow app list will find it.
const SLOW_LIST = 1000;

// How many releases to ask about at once.
//
// Not a throughput dial. Three keeps a check on a large catalogue from opening
// two hundred sockets from a television, and keeps the ordering of the log
// readable while it happens.
const AT_ONCE = 3;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

/** Whether there is anywhere to ask about an entry's released version. */
const askable = (entry) => entry.source.type === 'github';

/**
 * Builds the update check.
 *
 * `packages` is `tv/packages.js`, handed in rather than required so this can
 * be exercised off a television — which is the only place it can be. The
 * GitHub lookup is a parameter with a default for the same reason and one
 * more: the tests answer it themselves, and a suite that reached the network
 * would fail on the strength of somebody else's outage.
 */
const createUpdates = ({ packages, log, latestRelease = sources.latestRelease }) => {
    const say = log ? log.on('cat') : quiet;

    // repo -> { version, at }. Present means asked; a null version means asked
    // and told nothing useful, which is a different thing from never asked and
    // is remembered just as hard — a repository with no releases answers 404
    // as often as a busy one answers 200.
    //
    // In memory rather than on disk: the service outlives a reinstall of the
    // app but not a restart of the set, and the cost of forgetting is one
    // request.
    const remembered = {};

    const fresh = (repo) => {
        const known = remembered[repo];
        return known && Date.now() - known.at < CACHE_TTL ? known : null;
    };

    // What the television is holding: `{ map, at }`, or null until it has
    // answered once. `map` is package id -> installed version.
    //
    // Kept, rather than asked for each time, because `getPackagesInfo` is not
    // the free local call the note at the top of this file used to claim. On a
    // set with three hundred and twenty-one packages on it, it takes six
    // seconds. `mark` is awaited on the way to sending the catalogue, so for
    // as long as this was asked fresh every time, the app list arrived six
    // seconds after a phone asked for it — and most phone sessions are shorter
    // than six seconds. The frame was written to a socket that had already
    // gone, and the phone sat on "Nothing listed yet" having been told
    // nothing. That is the whole of "the app list is unreliable": not a
    // failure, a race with a call nobody had timed.
    //
    // So: asked once, kept for a minute, and refreshed *behind* whoever is
    // reading rather than in front of them. A slightly stale answer costs one
    // wrong word on one row. A slow one costs the entire screen.
    let holding = null;

    // The listing in flight, so that three phones asking at once — which the
    // log shows happening — share one six-second call instead of starting
    // three of them.
    let asking = null;

    // Bumped when something is installed. A listing already in flight when
    // that happens describes a television that no longer exists, so its answer
    // is kept but stamped stale, and the next read refreshes it.
    let generation = 0;

    const askTheSet = () => {
        if (asking) return asking;

        const era = generation;
        const began = Date.now();

        asking = packages.list().then(
            (list) => {
                asking = null;

                const map = list.reduce((byId, entry) => {
                    byId[entry.id] = entry.version;
                    return byId;
                }, {});

                const elapsed = Date.now() - began;

                say[elapsed >= SLOW_LIST ? 'info' : 'debug'](
                    `${list.length} packages installed, listed in ${took(elapsed)}`);

                holding = { map, at: era === generation ? Date.now() : 0 };

                return map;
            },
            (error) => {
                asking = null;

                // Off a television nothing is installed and there is nothing to
                // say about it — that is the development harness, not a fault. A
                // set that would not answer is worth a line, and costs the version
                // marks and nothing else.
                if (error.code !== 'notOnTv') say.warn(`could not list what is installed: ${error.message}`);

                // Whatever was last known beats nothing; nothing beats waiting.
                return holding ? holding.map : {};
            }
        );

        return asking;
    };

    /** Package id -> the version of it this television is holding. */
    const installedNow = async () => {
        // Nothing known yet, so there is no answer to give but the real one.
        // `prime()` exists so that this is paid at startup, with no phone on
        // the other end of it, rather than by whoever connects first.
        if (!holding) return askTheSet();

        // Stale: refresh, but do not make this caller wait for it.
        if (Date.now() - holding.at >= INSTALLED_TTL) askTheSet();

        return holding.map;
    };

    /**
     * Asks the set what it is holding, with nobody waiting on the answer.
     *
     * Called once at startup. It is six seconds on a full television, and this
     * is the one moment where six seconds costs nothing.
     */
    const prime = () => {
        askTheSet();
    };

    /**
     * Records that this service has just changed what the set is holding.
     *
     * The kept listing is not dropped — dropping it would make the next app
     * list block for six seconds, which is exactly the failure this cache
     * exists to remove, and it would do it at the moment somebody is watching
     * an install finish. It is stamped stale instead: the next read is served
     * from it immediately and refreshes it behind them.
     */
    const changed = () => {
        generation += 1;
        if (holding) holding = { map: holding.map, at: 0 };
        askTheSet();
    };

    /**
     * The catalogue with everything free written on it.
     *
     * Each entry gains `installed` — the version on this set, or null — and,
     * where it has already been asked about, `available` and `update`.
     * `checked` says whether `available` is an answer or an absence: a row
     * that has not been asked about yet and one whose app has no releases look
     * identical without it, and they mean different things to whoever is
     * looking at the button.
     */
    const mark = async (entries) => {
        const installed = await installedNow();

        return entries.map((entry) => {
            const current = entry.packageId ? installed[entry.packageId] || null : null;

            // Nothing to ask about a `url` app, so what the catalogue declares
            // is the answer and it is as checked as it will ever be.
            const known = askable(entry) ? fresh(entry.source.ref) : { version: entry.version };
            const available = known ? known.version : null;

            return {
                ...entry,
                // The version somebody would get, where that is known at all —
                // which is what the row shows beside the name.
                version: available || entry.version,
                installed: current,
                available,
                checked: Boolean(known),
                update: versions.isNewer(available, current)
            };
        });
    };

    /** One release lookup, remembered whichever way it goes. */
    const ask = async (repo) => {
        const found = await (async () => {
            try {
                const release = await latestRelease(repo);
                const version = versions.clean(release.tag_name);

                if (version) say.info(`${repo} has released ${version}`);
                else say.warn(`${repo}'s newest release is tagged ${release.tag_name || '(untagged)'}, which is not a version`);

                return version;
            } catch (error) {
                say.warn(`could not ask github about ${repo}: ${error.message}`);

                // A television that has spent its hour is not going to do
                // better on the next forty repositories, and hammering the
                // limit is how it stays spent. The caller stops.
                if (error.status === 403 || error.status === 429) throw error;

                return null;
            }
        })();

        remembered[repo] = { version: found, at: Date.now() };
    };

    /**
     * Asks about released versions — the expensive half, and only on request.
     *
     * `id` names one entry, which is re-asked whether or not the answer is
     * already in hand: somebody pressing check on a row they can see means
     * "now", not "if you have not already". Without an id every entry that has
     * not been asked about recently is checked, a few at a time, and the run
     * stops early if GitHub starts refusing — the rest of the catalogue would
     * only be refused too.
     */
    const check = async (entries, { id = null } = {}) => {
        const wanted = entries.filter((entry) => askable(entry) &&
            (id ? entry.id === id : !fresh(entry.source.ref)));

        if (!wanted.length) return mark(entries);

        say.info(`checking ${wanted.length === 1 ? wanted[0].name : `${wanted.length} apps`} for a newer release`);

        const queue = wanted.slice();
        let stopped = null;

        const worker = async () => {
            while (queue.length && !stopped) {
                const entry = queue.shift();

                try {
                    await ask(entry.source.ref);
                } catch (error) {
                    stopped = error;
                }
            }
        };

        await Promise.all(new Array(Math.min(AT_ONCE, queue.length)).fill(null).map(worker));

        if (stopped) {
            say.warn(`stopped checking: github refused (${stopped.message}). ` +
                'It allows sixty requests an hour to a television nobody has signed in from.');
        }

        const marked = await mark(entries);

        marked.filter((entry) => entry.update).forEach((entry) => say.ok(
            `${entry.name} ${entry.installed} is installed and ${entry.available} is out`));

        return marked;
    };

    return { mark, check, prime, changed };
};

module.exports = { createUpdates, CACHE_TTL, AT_ONCE, INSTALLED_TTL };
