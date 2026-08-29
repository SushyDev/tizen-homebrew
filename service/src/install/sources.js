'use strict';

const { readFileSync, existsSync, statSync } = require('fs');

const { getJson, getBuffer } = require('../remote/fetch.js');
const { size } = require('../obs/units.js');

const MAX_PACKAGE = 200 * 1024 * 1024;
const USER_AGENT = 'TizenHomebrew/1.0';

const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PACKAGE_SUFFIX = /\.(wgt|tpk)$/i;

const rejected = (code, message) => Object.assign(new Error(message), { code });

const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };
const reporter = (log) => (log ? log.on('pkg') : quiet);

const withinLimit = (archive, description) => {
    if (archive.length > MAX_PACKAGE) {
        throw rejected('downloadFailed', `${description} is ${archive.length} bytes, over the ${MAX_PACKAGE} limit.`);
    }
    return archive;
};

// Unauthenticated, so a private repository looks like a missing one, and `releases/latest` skips drafts.
const latestRelease = async (repo, log) => {
    if (!OWNER_REPO.test(repo)) throw rejected('badMessage', `"${repo}" is not an owner/repo reference.`);

    reporter(log).info(`asking github for the latest release of ${repo}`);

    try {
        return await getJson(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' }
        });
    } catch (error) {
        if (error.status === 404) {
            throw rejected('notFound', `${repo} has no published releases, or is private.`);
        }
        throw Object.assign(rejected('downloadFailed', error.message), { status: error.status });
    }
};

const fromGitHub = async (repo, log) => {
    const say = reporter(log);

    const release = await latestRelease(repo, log);

    const asset = (release.assets || []).find((candidate) => PACKAGE_SUFFIX.test(candidate.name));

    if (!asset) {
        throw rejected('notFound', `${release.tag_name || 'The latest release'} has no .wgt or .tpk asset.`);
    }

    say.info(`release ${release.tag_name || '(untagged)'} carries ${asset.name}` +
        `${asset.size ? ` (${size(asset.size)})` : ''}`);
    say.info(`downloading ${asset.browser_download_url}`);

    const archive = await getBuffer(asset.browser_download_url, { headers: { 'user-agent': USER_AGENT } });

    return { archive: withinLimit(archive, asset.name), name: asset.name };
};

const fromUrl = async (url, log) => {
    if (!url.startsWith('https://')) throw rejected('badMessage', 'Package URLs must use https.');

    reporter(log).info(`downloading ${url}`);

    const archive = await getBuffer(url, { headers: { 'user-agent': USER_AGENT } });

    return { archive: withinLimit(archive, url), name: url.split('/').pop() };
};

const fromFile = (path, log) => {
    if (!existsSync(path)) throw rejected('notFound', `No file at ${path}.`);
    if (statSync(path).size > MAX_PACKAGE) throw rejected('badPackage', 'File is larger than the size limit.');

    reporter(log).info(`reading ${path} off the television's own disk`);

    return { archive: readFileSync(path), name: path.split('/').pop() };
};

const resolve = async ({ source, reference, catalog = [], upload = null, log = null }) => {
    switch (source) {
        case 'upload':
            if (!upload || !upload.length) throw rejected('badPackage', 'No package body received.');
            reporter(log).info(`taking ${size(upload.length)} straight from the request body`);
            return { archive: withinLimit(upload, 'Upload'), name: reference || 'upload' };

        case 'catalog': {
            const entry = catalog.find((candidate) => candidate.id === reference);
            if (!entry) throw rejected('notFound', `No catalog app with id "${reference}".`);
            reporter(log).info(`catalog entry "${reference}" is ${entry.source.type} ${entry.source.ref}`);
            return resolve({ source: entry.source.type, reference: entry.source.ref, catalog, log });
        }

        case 'github': return fromGitHub(reference, log);
        case 'url': return fromUrl(reference, log);
        case 'file': return fromFile(reference, log);

        default: throw rejected('badMessage', `Unknown install source "${source}".`);
    }
};

module.exports = { resolve, latestRelease, MAX_PACKAGE };
