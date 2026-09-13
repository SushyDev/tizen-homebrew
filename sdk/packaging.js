'use strict';

// A .wgt is a zip with two signature files in it. This reads one, builds one from a directory, and
// puts the signatures back — the whole of what `tizenjs build` did, without the CLI in between.

const { sep } = require('path');
const { createHash } = require('crypto');

const JSZip = require('jszip');

const signing = require('./signing.js');

const SIGNATURE_FILE = /^(author-signature\.xml|signature\d*\.xml)$/i;

// A widget names itself in config.xml and a native or .NET package in tizen-manifest.xml. Signing
// treats both the same, so the manifest is only ever asked for as proof this is a Tizen package.
const MANIFESTS = ['config.xml', 'tizen-manifest.xml'];

const refuse = (message) => Object.assign(new Error(message), { code: 'packagingFailed', isFriendly: true });

// The URIs are percent-encoded whole, so a separator becomes `%2F`, and are decoded on the way out.
const uriOf = (path) => encodeURIComponent(path.split(sep).join('/'));
const pathOf = (uri) => decodeURIComponent(uri);

const open = (archive) => JSZip.loadAsync(archive).catch(() => {
    throw refuse('That file is not a readable package — a .wgt is a zip, and this one would not open.');
});

const contentsOf = async (archive) => {
    const zip = await open(archive);

    const files = await Promise.all(Object.keys(zip.files)
        .filter((name) => !zip.files[name].dir && !SIGNATURE_FILE.test(name))
        .map(async (name) => ({ uri: uriOf(name), data: await zip.files[name].async('nodebuffer') })));

    if (!files.some((file) => MANIFESTS.indexOf(pathOf(file.uri)) !== -1)) {
        throw refuse('That package has no config.xml or tizen-manifest.xml, so it is not a Tizen package.');
    }

    return files;
};

const pack = (files) => files
    .reduce((zip, file) => zip.file(pathOf(file.uri), file.data), new JSZip())
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

const build = async (files, pair) => pack(signing.sign(files, pair));

const resign = async (archive, pair) => {
    const files = await contentsOf(archive);

    return { archive: await build(files, pair), files: files.length };
};

const manifestIn = async (archive) => {
    const zip = await open(archive);
    const file = zip.files['config.xml'];

    if (!file) throw refuse('That package holds no config.xml, so it is not a Tizen widget.');

    return file.async('string');
};

const idsIn = (manifest) => {
    const packageId = /<tizen:application\b[^>]*\bpackage="([^"]+)"/.exec(manifest);
    const appId = /<tizen:application\b[^>]*\bid="([^"]+)"/.exec(manifest);

    if (!packageId || !appId) throw refuse('That package has no readable <tizen:application> ids.');

    return { packageId: packageId[1], appId: appId[1] };
};

const REFERENCE = /<Reference URI="([^"]+)">[\s\S]*?<DigestValue>([\s\S]*?)<\/DigestValue>/g;

const digestsIn = (xml) => Array.from(xml.matchAll(REFERENCE))
    .filter(([, uri]) => uri !== '#prop')
    .reduce((all, [, uri, digest]) => ({ ...all, [uri]: digest.replace(/\s/g, '') }), {});

const certificatesIn = (xml) => Array.from(xml.matchAll(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/g))
    .map(([, body]) => `-----BEGIN CERTIFICATE-----\n${body.trim()}\n-----END CERTIFICATE-----\n`);

// What the package says about itself: which files each signature covers, whether those digests still
// match, and which certificates signed it. Nothing here needs the private half of anything.
const inspect = async (archive) => {
    const zip = await open(archive);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

    const signatures = await Promise.all(names
        .filter((name) => SIGNATURE_FILE.test(name))
        .sort()
        .map(async (name) => ({ name, xml: await zip.files[name].async('string') })));

    // Every entry, signatures included: the distributor signature covers the author's, and a package
    // whose author signature was swapped afterwards is exactly what that reference is there to catch.
    const digested = await Promise.all(names.map(async (name) => ({
        uri: uriOf(name),
        digest: createHash('sha512').update(await zip.files[name].async('nodebuffer')).digest('base64')
    })));

    const found = digested.reduce((all, entry) => ({ ...all, [entry.uri]: entry.digest }), {});

    return {
        signed: signatures.length >= 2,
        files: names.filter((name) => !SIGNATURE_FILE.test(name)).length,
        certificates: signatures.reduce((all, entry) => [...all, ...certificatesIn(entry.xml)], []),
        signatures: signatures.map((entry) => {
            const claimed = digestsIn(entry.xml);

            return {
                name: entry.name,
                covers: Object.keys(claimed).length,
                missing: Object.keys(claimed).filter((uri) => found[uri] === undefined),
                mismatched: Object.keys(claimed).filter((uri) => found[uri] !== claimed[uri])
            };
        })
    };
};

module.exports = {
    contentsOf, pack, build, resign, inspect,
    manifestIn, idsIn, uriOf, pathOf, SIGNATURE_FILE, MANIFESTS
};
