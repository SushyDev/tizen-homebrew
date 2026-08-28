'use strict';

// What the television already has, and whether anything newer has been
// released since it got it.
//
// A catalogue row can say "install" without knowing anything at all. Saying
// "update" takes two facts it does not have: which version of the app is on
// this set, and which version the app is at now. The first comes from the
// platform's own package list; the second comes from GitHub, because a version
// written into the catalogue is a statement somebody has to keep true by hand
// and the release is the thing that actually moves. Tizen Homebrew is in its
// own catalogue for exactly this reason — a set carries its own next version
// to itself, and hand-editing a JSON file is not a mechanism that survives.
//
// It costs one request per *installed* catalogue app, and none at all for the
// rest: an app you do not have cannot have an update, so a fresh television
// asks GitHub nothing. Answers are remembered for six hours and negative ones
// are remembered too — a repository with no releases answers 404 just as often
// as a busy one answers 200, and the unauthenticated budget is sixty an hour.

const sources = require('./sources.js');
const versions = require('./versions.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

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

    // repo -> { version, at }. In memory rather than on disk: the service
    // outlives a reinstall of the app but not a restart of the set, and the
    // cost of being wrong here is one request.
    const remembered = {};

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
            // set that would not answer is worth a line, and costs the update
            // marks and nothing else.
            if (error.code !== 'notOnTv') say.warn(`could not list what is installed: ${error.message}`);

            return {};
        }
    };

    /** What an entry's app is at now, as far as anything can be asked. */
    const published = async (entry, refresh) => {
        // Nobody to ask about a `url` app, so what the catalogue declares is
        // the only answer there is — and it is the fallback for a `github` one
        // whose origin did not answer.
        if (entry.source.type !== 'github') return entry.version;

        const repo = entry.source.ref;
        const known = remembered[repo];

        if (!refresh && known && Date.now() - known.at < CACHE_TTL) {
            return known.version || entry.version;
        }

        const found = await (async () => {
            try {
                const release = await latestRelease(repo);
                const version = versions.clean(release.tag_name);

                if (version) say.info(`${repo} has released ${version}`);
                else say.warn(`${repo}'s newest release is tagged ${release.tag_name || '(untagged)'}, which is not a version`);

                return version;
            } catch (error) {
                say.warn(`could not ask github about ${repo}: ${error.message}`);
                return null;
            }
        })();

        remembered[repo] = { version: found, at: Date.now() };

        return found || entry.version;
    };

    /**
     * The catalogue, with what is installed marked on it.
     *
     * Returns null — rather than the list unchanged — when there was nothing
     * to learn, so a caller can tell "asked, and nothing is installed" from
     * "here is a second answer worth sending".
     *
     * Each entry that is installed gains `installed`, the version on this set;
     * `version`, the one on offer; and `update`, which is the whole point and
     * is decided here rather than on the phone so there is one comparator
     * rather than two.
     */
    const mark = async (entries, { refresh = false } = {}) => {
        const installed = await installedNow();

        // An app this television does not have cannot have an update, and
        // finding that out is free — so the requests below are only ever spent
        // on rows that could actually change.
        const held = entries.filter((entry) => entry.packageId && installed[entry.packageId]);

        if (!held.length) return null;

        const offered = {};

        await Promise.all(held.map(async (entry) => {
            offered[entry.id] = await published(entry, refresh);
        }));

        const marked = entries.map((entry) => {
            const current = entry.packageId ? installed[entry.packageId] : null;

            if (!current) return entry;

            const available = offered[entry.id] || entry.version;

            return {
                ...entry,
                version: available,
                installed: current,
                update: versions.isNewer(available, current)
            };
        });

        marked.filter((entry) => entry.update).forEach((entry) => say.ok(
            `${entry.name} ${entry.installed} is installed and ${entry.version} is out`));

        return marked;
    };

    return { mark };
};

module.exports = { createUpdates, CACHE_TTL };
