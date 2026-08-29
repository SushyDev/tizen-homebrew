'use strict';

// A Tizen package carries two signatures, and from Tizen 7 the distributor certificate names the
// device it was minted for — so a package signed by whoever built it installs on their set and
// nowhere else. Given a pair minted for this TV, any package becomes installable on it.
//
// Old signatures are dropped rather than amended: every file is digested afresh, signed as the
// author, then as the distributor over the author's signature, which is the order the format wants.
//
// install/signature.js is the `tizen` CLI's own signer taking PEM instead of a PKCS#12, including
// the `%2F` in its reference URIs, which looks like a bug and is what a television accepts.

const JSZip = require('jszip');
const Signature = require('./signature.js');

const SIGNATURE_FILE = /^(author-signature\.xml|signature\d*\.xml)$/i;

const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

const isPair = (pair) => Boolean(pair) &&
    Array.isArray(pair.certificates) && pair.certificates.length &&
    pair.certificates.every((pem) => typeof pem === 'string' && /BEGIN CERTIFICATE/.test(pem)) &&
    typeof pair.key === 'string' && /BEGIN [A-Z ]*PRIVATE KEY/.test(pair.key);

const openPair = (certificates) => {
    const open = (pair, which) => {
        if (!pair) throw refuse(`No ${which} certificate is stored for this television.`);
        if (!isPair(pair)) throw refuse(`The stored ${which} certificate is not readable — send the pair again.`);
        return pair;
    };

    return {
        author: open((certificates || {}).author, 'author'),
        distributor: open((certificates || {}).distributor, 'distributor')
    };
};

// Recorded when the pair was sent: reading it back needs an ASN.1 parser, and one pair covers several sets.
const devicesOf = (certificates) => {
    const named = (certificates || {}).certDuids;

    if (Array.isArray(named)) return named.filter(Boolean);

    return (certificates || {}).certDuid ? [certificates.certDuid] : [];
};

const deviceOf = (certificates) => devicesOf(certificates)[0] || null;

const resign = async (archive, certificates) => {
    const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

    // The URIs are percent-encoded, so a separator becomes `%2F` and is decoded back on the way out.
    const contentsOf = async (zip) => {
        const named = await Promise.all(Object.keys(zip.files)
            .filter((name) => !zip.files[name].dir && !SIGNATURE_FILE.test(name))
            .map(async (name) => ({
                uri: encodeURIComponent(name),
                data: await zip.files[name].async('nodebuffer')
            })));

        if (!named.some((file) => decodeURIComponent(file.uri) === 'config.xml')) {
            throw refuse('That package has no config.xml, so it is not a Tizen widget.');
        }

        return named;
    };

    const repack = async (files) => {
        const zip = files.reduce((out, file) => out.file(decodeURIComponent(file.uri), file.data), new JSZip());

        return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    };

    const { author, distributor } = openPair(certificates);

    const zip = await JSZip.loadAsync(archive).catch(() => {
        throw refuse('That file is not a readable package — a .wgt is a zip, and this one would not open.');
    });

    const contents = await contentsOf(zip);

    // Counted first: `Signature.sign` unshifts its own output into the array it is given.
    const digested = contents.length;

    const authored = await new Signature('AuthorSignature', contents).sign(author);
    const signed = await new Signature('DistributorSignature', authored).sign(distributor);

    return {
        archive: await repack(signed),
        device: deviceOf(certificates),
        files: digested
    };
};

module.exports = { resign, openPair, deviceOf, devicesOf, SIGNATURE_FILE };
