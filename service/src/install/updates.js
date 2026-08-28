'use strict';

// What the television already has, and what the catalogue could give it.
//
// Two questions, and they cost wildly different amounts to answer.
//
// *What is installed* comes from the platform's own package list: one local
// call, no network, and the answer covers every app at once. So it is asked
// every time the catalogue is sent, and every row knows immediately whether
// it is already on this set and at which version.
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

const CACHE_TTL = 6 * 60 * 60 * 1000;

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

    /** Package id -> the version of it this television is holding. */
    const installedNow = async () => {
        try {
            const list = await packages.list();

            return list.reduce((byId, entry) => {
                byId[entry.id] = entry.version;
                return byId;
            }, {});
        } catch (error) {
            // Off a television nothing is installed and there is nothing to
            // say about it — that is the development harness, not a fault. A
            // set that would not answer is worth a line, and costs the version
            // marks and nothing else.
            if (error.code !== 'notOnTv') say.warn(`could not list what is installed: ${error.message}`);

            return {};
        }
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

    return { mark, check };
};

module.exports = { createUpdates, CACHE_TTL, AT_ONCE };
