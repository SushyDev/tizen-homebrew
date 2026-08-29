'use strict';

const { createHash } = require('crypto');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');

const { getBuffer, getJson } = require('./fetch.js');

const digestOf = (buffer) => createHash('sha256').update(buffer).digest('hex');

// Nothing is used unless its SHA-256 matches the manifest's digest, and it is checked on every read.
const createLoader = ({ origin, cacheDir, manifestPath = 'latest.json' }) => {
    const cachedAt = (name) => join(cacheDir, name);

    const readCached = (name, expected) => {
        const path = cachedAt(name);
        if (!existsSync(path)) return null;

        try {
            const bytes = readFileSync(path);
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
            console.error(`Could not cache ${name}: ${error.message}`);
        }
    };

    const manifest = () => getJson(`${origin}/${manifestPath}`);

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
