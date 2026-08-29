'use strict';

// Re-signing a package for this television.
//
// A Tizen package carries two signatures, the author's and the distributor's,
// and the distributor certificate names the device it was minted for:
//
//     URI:URN:tizen:deviceid=CPCLIM2YRW7DO
//
// From Tizen 7 the television enforces that, so a package signed by whoever
// built it installs on their set and nowhere else. That one fact is why a
// channel cannot simply hand out .wgt files — and why this exists. Given a
// pair of certificates minted for *this* TV, any package becomes installable
// on it: one signed by a stranger, one signed for a different set, or one that
// was never signed at all.
//
// Old signatures are dropped rather than amended. Every remaining file is
// digested afresh and the stored pair signs the result: first as the author,
// then as the distributor *over* the author's signature — which is the order
// the format requires, and the reason the two calls below are chained rather
// than independent.
//
// The signing is install/signature.js, which is the `tizen` CLI's own signer
// taking PEM instead of a PKCS#12 — so a package re-signed here has the shape of
// one signed by the CLI, including the `%2F` in its reference URIs, which looks
// like a bug and is what a television accepts.

const JSZip = require('jszip');
const Signature = require('./signature.js');

// What Tizen puts a signature in. Anything matching is stale by definition: it
// signs the package as it was before we touched it.
const SIGNATURE_FILE = /^(author-signature\.xml|signature\d*\.xml)$/i;

const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

/** True when `pair` is `{ certificates: [pem], key: pem }` and usable. */
const isPair = (pair) => Boolean(pair) &&
    Array.isArray(pair.certificates) && pair.certificates.length &&
    pair.certificates.every((pem) => typeof pem === 'string' && /BEGIN CERTIFICATE/.test(pem)) &&
    typeof pair.key === 'string' && /BEGIN [A-Z ]*PRIVATE KEY/.test(pair.key);

/**
 * Both halves of a stored pair, or which one is wrong.
 *
 * Checked together because a pair is only useful together, and here rather than
 * at the end of an install, minutes later, as something that reads like the
 * television's fault.
 */
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

/**
 * Every device a stored pair names.
 *
 * Recorded when the pair was sent rather than read back out of it: the reading
 * needs an ASN.1 parser, which is the dependency this file exists without.
 * `--duidList` is a list and one pair legitimately covers several sets, so
 * folding it to one entry refuses installs on televisions the pair is good for.
 */
const devicesOf = (certificates) => {
    const named = (certificates || {}).certDuids;

    if (Array.isArray(named)) return named.filter(Boolean);

    return (certificates || {}).certDuid ? [certificates.certDuid] : [];
};

const deviceOf = (certificates) => devicesOf(certificates)[0] || null;

/**
 * Re-signs `archive` with the certificates stored for this television.
 *
 * `certificates` is the shape config.js keeps: an `author` and a `distributor`,
 * each `{ certificates: [pem], key: pem }`, plus the devices they name.
 */
const resign = async (archive, certificates) => {
    const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

    // Everything in the package except the signatures, which are what is being
    // replaced. The URIs are percent-encoded, so a path separator becomes
    // `%2F` and the zip entry is decoded back on the way out; that is not a
    // choice here, it is the format the television reads.
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

    // Counted here, before it is handed over. `Signature.sign` unshifts its own
    // output into the array it is given rather than returning a new one, so by
    // the end `contents` is the signed list and counting it then reports two
    // signature files as though they were part of the package.
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
