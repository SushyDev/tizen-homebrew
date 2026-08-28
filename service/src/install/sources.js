'use strict';

// Where a package comes from.
//
// Five origins, one shape: each resolves to `{ archive, name }` and the
// pipeline downstream neither knows nor cares which was used. Adding a sixth
// means adding one entry here.

const { readFileSync, existsSync, statSync } = require('fs');

const { getJson, getBuffer } = require('../remote/fetch.js');
const { size } = require('../obs/units.js');

const MAX_PACKAGE = 200 * 1024 * 1024;
const USER_AGENT = 'TizenHomebrew/1.0';

const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PACKAGE_SUFFIX = /\.(wgt|tpk)$/i;

const rejected = (code, message) => Object.assign(new Error(message), { code });

// Where a reporter is handed in, each origin says what it resolved before it
// spends thirty seconds downloading it — the step most likely to be slow is
// the one that must not be silent.
const quiet = { info: () => {}, ok: () => {}, warn: () => {}, err: () => {}, debug: () => {} };
const reporter = (log) => (log ? log.on('pkg') : quiet);

const withinLimit = (archive, description) => {
    if (archive.length > MAX_PACKAGE) {
        throw rejected('downloadFailed', `${description} is ${archive.length} bytes, over the ${MAX_PACKAGE} limit.`);
    }
    return archive;
};

/**
 * The newest published release of `owner/repo`, as GitHub describes it.
 *
 * Only public repositories work: the call is unauthenticated, so a private
 * repository is indistinguishable from a missing one — GitHub answers 404 for
 * both, and saying so is more useful than "not found".
 *
 * Drafts and prereleases are not it — `releases/latest` skips both. That is
 * what makes a release built by CI invisible until a person publishes the
 * draft, which is the one manual step in shipping one.
 *
 * Separate from the download below because it answers a second question as
 * well: `install/updates.js` asks what version an app is at without wanting
 * the twenty megabytes that go with it.
 */
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
        throw rejected('downloadFailed', error.message);
    }
};

/** The package in that release, downloaded. */
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

/**
 * Resolves an install request to bytes.
 *
 * `catalog` is deliberately recursive: a catalogue entry is a label on one of
 * the other sources, not a fourth way of fetching.
 */
const resolve = async ({ source, reference, catalog = [], upload = null, log = null }) => {
    switch (source) {
        case 'upload':
            if (!upload || !upload.length) throw rejected('badPackage', 'No package body received.');
            reporter(log).info(`taking ${size(upload.length)} straight from the request body`);
            return { archive: withinLimit(upload, 'Upload'), name: reference || 'upload' };

        case 'catalog': {
            const entry = catalog.find((candidate) => candidate.id === reference);
            if (!entry) throw rejected('notFound', `No catalogue app with id "${reference}".`);
            reporter(log).info(`catalogue entry "${reference}" is ${entry.source.type} ${entry.source.ref}`);
            return resolve({ source: entry.source.type, reference: entry.source.ref, catalog, log });
        }

        case 'github': return fromGitHub(reference, log);
        case 'url': return fromUrl(reference, log);
        case 'file': return fromFile(reference, log);

        default: throw rejected('badMessage', `Unknown install source "${source}".`);
    }
};

module.exports = { resolve, latestRelease, MAX_PACKAGE };
