'use strict';

// The list of apps Tizen Homebrew offers.
//
// Served from our own origin rather than jsDelivr, and cached on disk so a TV
// with no working uplink shows the last known list instead of an empty screen.
// This is data, not code, so it is not digest-checked the way the resigning
// module is — a wrong catalogue entry can only lead to an install the user
// then has to confirm.

const { readFileSync, writeFileSync, existsSync, statSync } = require('fs');

const { getJson } = require('../remote/fetch.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

/**
 * Where a catalogue app's logo comes from when the entry does not name one.
 *
 * `logo.png` in the root of the repository the app is released from, on the
 * default branch — which is what `HEAD` means to raw.githubusercontent, and
 * saves every entry restating a branch name that is only going to go stale.
 *
 * A convention rather than a requirement: an app with no logo.png answers 404,
 * the phone quietly draws a monogram instead, and nothing else happens. That
 * is the whole reason this is guessed rather than demanded — a catalogue that
 * refused apps without artwork would be a catalogue with fewer apps in it.
 */
const logoFor = (source) => (source.type === 'github'
    ? `https://raw.githubusercontent.com/${source.ref}/HEAD/logo.png`
    : null);

/** Keeps only entries shaped the way the UI and `sources.resolve` expect. */
const usable = (entry) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string') return null;
    if (!entry.source || !['github', 'url'].includes(entry.source.type)) return null;
    if (typeof entry.source.ref !== 'string') return null;

    const source = { type: entry.source.type, ref: entry.source.ref };

    return {
        id: entry.id,
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        version: typeof entry.version === 'string' ? entry.version : null,
        // https only, for the same reason sources.js requires it of a package
        // URL. An icon is a much smaller thing to be wrong about, but it comes
        // out of the same catalogue and there is no argument for holding it to
        // a lower standard than the bytes it sits next to.
        icon: typeof entry.icon === 'string' && entry.icon.startsWith('https://')
            ? entry.icon
            : logoFor(source),
        source
    };
};

const createCatalog = ({ url, cachePath, log }) => {
    const say = log ? log.on('cat') : quiet;

    const readCache = () => {
        if (!existsSync(cachePath)) return null;

        try {
            return {
                entries: JSON.parse(readFileSync(cachePath, 'utf8')),
                age: Date.now() - statSync(cachePath).mtime.getTime()
            };
        } catch (e) {
            return null;
        }
    };

    /**
     * Returns `{ entries, stale, source }` — never just a list, because the UI
     * has to be able to say "this is what we last knew" rather than presenting
     * an outdated catalogue as current.
     */
    const fetch = async ({ refresh = false } = {}) => {
        const cached = readCache();

        if (!refresh && cached && cached.age < CACHE_TTL) {
            say.info(`${cached.entries.length} apps from the cache, ${took(cached.age)} old`);
            return { entries: cached.entries, stale: false, source: 'cache' };
        }

        const began = Date.now();

        try {
            say.info(`fetching ${url}`);

            const body = await getJson(url, { headers: { 'user-agent': 'TizenHomebrew/1.0' } });
            const listed = Array.isArray(body) ? body : body && body.apps;

            if (!Array.isArray(listed)) throw new Error('Catalogue was not a list of apps.');

            const entries = listed.map(usable).filter(Boolean);

            try {
                writeFileSync(cachePath, JSON.stringify(entries));
            } catch (e) {
                // An unwritable cache costs a refetch, nothing more — but a TV
                // that cannot write its own storage is worth knowing about.
                say.warn(`could not cache the catalogue at ${cachePath}: ${e.message}`);
            }

            say.ok(`${entries.length} apps${listed.length !== entries.length
                ? `, ${listed.length - entries.length} of ${listed.length} rejected as malformed` : ''} ` +
                `in ${took(Date.now() - began)}`);

            return { entries, stale: false, source: 'network' };
        } catch (error) {
            if (cached) {
                say.warn(`origin unreachable (${error.message}) — showing ${cached.entries.length} cached apps instead`);
                return { entries: cached.entries, stale: true, source: 'cache', error: error.message };
            }

            say.err(`no catalogue and no cache: ${error.message}`);
            throw Object.assign(new Error(`Could not load the app catalogue: ${error.message}`), { code: 'downloadFailed' });
        }
    };

    return { fetch };
};

module.exports = { createCatalog, usable, logoFor };
