'use strict';

const { readFileSync, writeFileSync, existsSync, statSync } = require('fs');

const { getJson } = require('../remote/fetch.js');
const { took } = require('../obs/units.js');

const CACHE_TTL = 6 * 60 * 60 * 1000;

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };

// Guessed, not required: an app with no logo.png answers 404 and the phone draws a monogram.
const logoFor = (source) => (source.type === 'github'
    ? `https://raw.githubusercontent.com/${source.ref}/HEAD/logo.png`
    : null);

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
        packageId: typeof entry.packageId === 'string' ? entry.packageId : null,
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

            if (!Array.isArray(listed)) throw new Error('Catalog was not a list of apps.');

            const entries = listed.map(usable).filter(Boolean);

            try {
                writeFileSync(cachePath, JSON.stringify(entries));
            } catch (e) {
                say.warn(`could not cache the catalog at ${cachePath}: ${e.message}`);
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

            say.err(`no catalog and no cache: ${error.message}`);
            throw Object.assign(new Error(`Could not load the app catalog: ${error.message}`), { code: 'downloadFailed' });
        }
    };

    return { fetch };
};

module.exports = { createCatalog, usable, logoFor };
