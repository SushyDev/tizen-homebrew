'use strict';

// What is installed is free; what has been released costs a request per app, so it waits to be asked.

const sources = require('./sources.js');
const versions = require('./versions.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

// Short, because being wrong shows an install button beside an app installed a moment ago.
const INSTALLED_TTL = 60 * 1000;

const SLOW_LIST = 1000;

// Has to be truthy: one field answers both "is it installed" and "at which version".
const UNKNOWN_VERSION = '?';

const AT_ONCE = 3;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

const askable = (entry) => entry.source.type === 'github';

// `packages` and the GitHub lookup are handed in so this can be exercised off a television.
const createUpdates = ({ packages, log, config, latestRelease = sources.latestRelease }) => {
    const say = log ? log.on('cat') : quiet;

    // repo -> { version, at }. A remembered null is "asked, told nothing", not "never asked".
    const remembered = {};

    const fresh = (repo) => {
        const known = remembered[repo];
        return known && Date.now() - known.at < CACHE_TTL ? known : null;
    };

    // Package id -> installed version, kept because getPackagesInfo takes six seconds on a full set.
    let holding = null;

        let asking = null;

        let generation = 0;

    const askTheSet = () => {
        if (asking) return asking;

        const era = generation;
        const began = Date.now();

        // Logged before the call: getPackagesInfo has been seen to never come back on Tizen 9.
        say.info('asking the television what it is holding');

        asking = packages.list({ say }).then(
            (list) => {
                asking = null;

                const map = list.reduce((byId, entry) => {
                    byId[entry.id] = entry.version || UNKNOWN_VERSION;
                    return byId;
                }, {});

                // Fills in versions this service wrote down itself; only ever overwrites a `?`.
                (config ? config.read().lastInstalled || [] : []).forEach((seen) => {
                    if (seen.version && map[seen.packageId] === UNKNOWN_VERSION) {
                        map[seen.packageId] = seen.version;
                    }
                });

                const elapsed = Date.now() - began;

                say[elapsed >= SLOW_LIST ? 'info' : 'debug'](
                    `${list.length} packages installed, listed in ${took(elapsed)}`);

                holding = { map, at: era === generation ? Date.now() : 0 };

                return map;
            },
            (error) => {
                asking = null;

                // Off a television nothing is installed, which is the development harness rather than a fault.
                if (error.code !== 'notOnTv') say.warn(`could not list what is installed: ${error.message}`);

                return holding ? holding.map : {};
            }
        );

        return asking;
    };

    const installedNow = async () => {
        if (!holding) return askTheSet();

        if (Date.now() - holding.at >= INSTALLED_TTL) askTheSet();

        return holding.map;
    };

    const prime = () => {
        askTheSet();
    };

    // Stamped stale rather than dropped, so the next read is served immediately and refreshes behind it.
    const changed = () => {
        generation += 1;
        if (holding) holding = { map: holding.map, at: 0 };
        askTheSet();
    };

    // `checked` separates "not asked yet" from "asked, and there are no releases".
    const mark = async (entries) => {
        const installed = await installedNow();

        return entries.map((entry) => {
            const current = entry.packageId ? installed[entry.packageId] || null : null;

            const known = askable(entry) ? fresh(entry.source.ref) : { version: entry.version };
            const available = known ? known.version : null;

            return {
                ...entry,
                version: available || entry.version,
                installed: current,
                available,
                checked: Boolean(known),
                update: versions.isNewer(available, current)
            };
        });
    };

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

                // A television that has spent its hour will not do better on the next forty repositories.
                if (error.status === 403 || error.status === 429) throw error;

                return null;
            }
        })();

        remembered[repo] = { version: found, at: Date.now() };
    };

    // `id` re-asks one entry even when the answer is in hand; without one, everything stale.
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
