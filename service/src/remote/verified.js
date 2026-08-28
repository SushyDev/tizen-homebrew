'use strict';

// Fetching code and data that will be trusted, and refusing it when it is not
// what was promised.
//
// Tizen Homebrew fetches two kinds of thing at runtime: an app catalogue, and — on
// Tizen 7+ — the resigning module, which is *executed*. Running code pulled
// off a network is exactly what TizenBrew does (`serviceLauncher.js` hands CDN
// source to vm.runInContext with require injected, unpinned and unchecked),
// and exactly what this project set out not to copy.
//
// The difference is this file: nothing is used unless its SHA-256 matches a
// digest the manifest named, and the check is repeated on every read rather
// than trusted once at download. A file truncated by a power cut is refused
// the same way a substituted one is.

const { createHash } = require('crypto');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');

const { getBuffer, getJson } = require('./fetch.js');

const digestOf = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Builds a loader over one origin and one cache directory.
 *
 * `manifestPath` names a small JSON document listing what may be fetched and
 * the digest each must have, so the origin cannot quietly serve something
 * else later.
 */
const createLoader = ({ origin, cacheDir, manifestPath = 'latest.json' }) => {
    const cachedAt = (name) => join(cacheDir, name);

    const readCached = (name, expected) => {
        const path = cachedAt(name);
        if (!existsSync(path)) return null;

        try {
            const bytes = readFileSync(path);
            // Re-verified on every read, not trusted from when it was written.
            return digestOf(bytes) === expected ? bytes : null;
        } catch (e) {
            return null;
        }
    };

    const writeCached = (name, bytes) => {
        try {
            mkdirSync(dirname(cachedAt(name)), { recursive: true });
            writeFileSync(cachedAt(name), bytes);
        } catch (error) {
            // A full or read-only filesystem costs a re-download next time,
            // which is not worth failing the current request over.
            console.error(`Could not cache ${name}: ${error.message}`);
        }
    };

    /** The manifest naming what is available and what each should hash to. */
    const manifest = () => getJson(`${origin}/${manifestPath}`);

    /**
     * Returns the bytes of `name`, from cache when they match and from the
     * origin otherwise. Throws when what arrives is not what was promised —
     * the whole point of the exercise.
     */
    const load = async (name, expectedDigest) => {
        const cached = readCached(name, expectedDigest);
        if (cached) return cached;

        const fetched = await getBuffer(`${origin}/${name}`);
        const actual = digestOf(fetched);

        if (actual !== expectedDigest) {
            throw Object.assign(
                new Error(`${name} did not match its digest — expected ${expectedDigest}, got ${actual}`),
                { code: 'digestMismatch' }
            );
        }

        writeCached(name, fetched);
        return fetched;
    };

    return { manifest, load, digestOf };
};

module.exports = { createLoader, digestOf };
