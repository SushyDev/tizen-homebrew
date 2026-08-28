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
// The signing itself is `tizen`'s, the same implementation `npm run package`
// uses on a laptop, so a package re-signed here has the shape of one signed by
// the CLI — including the `%2F` in its reference URIs, which looks like a bug
// and is what a television accepts.

const forge = require('node-forge');
const JSZip = require('jszip');
const { Signature } = require('tizen');

// What Tizen puts a signature in. Anything matching is stale by definition: it
// signs the package as it was before we touched it.
const SIGNATURE_FILE = /^(author-signature\.xml|signature\d*\.xml)$/i;

const refuse = (message) => Object.assign(new Error(message), { code: 'resignFailed' });

/**
 * Opens a stored pair, or says which half would not open.
 *
 * Both halves are opened together because a pair is only useful together, and
 * because this is the one moment a bad password can be reported to somebody
 * who is still looking — rather than at the end of an install, minutes later,
 * as a failure that reads like the television's fault.
 */
const openPair = (certificates) => {
    const open = (base64, which) => {
        if (!base64) throw refuse(`No ${which} certificate is stored for this television.`);

        try {
            const der = forge.util.createBuffer(Buffer.from(base64, 'base64').toString('binary'));
            return forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, certificates.password);
        } catch (e) {
            throw refuse(`The ${which} certificate would not open — wrong password, or a damaged file.`);
        }
    };

    return { author: open(certificates.authorCert, 'author'), distributor: open(certificates.distributorCert, 'distributor') };
};

/**
 * The device a certificate was minted for, or null.
 *
 * Read back out of the certificate rather than trusted from whatever wrote it
 * down. Certificates for the wrong television are the one failure that looks
 * exactly like a working install, right up until the television refuses it.
 */
const deviceOf = (p12) => p12.safeContents
    .reduce((bags, contents) => bags.concat(contents.safeBags), [])
    .filter((bag) => bag.type === forge.pki.oids.certBag && bag.cert)
    .reduce((found, bag) => {
        const extension = bag.cert.getExtension('subjectAltName');
        const names = (extension && extension.altNames) || [];

        return found || names
            .map((name) => /deviceid=(.+)$/.exec(name.value || ''))
            .filter(Boolean)
            .map((match) => match[1])[0] || null;
    }, null);

/**
 * Re-signs `archive` with the certificates stored for this television.
 *
 * `certificates` is the shape config.js keeps: base64 of each DER .p12, and
 * the one password that opens both.
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
        device: deviceOf(distributor),
        files: digested
    };
};

module.exports = { resign, openPair, deviceOf, SIGNATURE_FILE };
