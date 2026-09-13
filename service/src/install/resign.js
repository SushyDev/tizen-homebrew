'use strict';

// A Tizen package carries two signatures, and from Tizen 7 the distributor certificate names the
// device it was minted for — so a package signed by whoever built it installs on their set and
// nowhere else. Given a pair minted for this TV, any package becomes installable on it.
//
// Old signatures are dropped rather than amended: every file is digested afresh, signed as the
// author, then as the distributor over the author's signature, which is the order the format wants.

const packaging = require('../../../sdk/packaging.js');

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
    const pair = openPair(certificates);

    const done = await packaging.resign(archive, pair).catch((error) => {
        throw refuse(error.message);
    });

    return {
        archive: done.archive,
        device: deviceOf(certificates),
        files: done.files
    };
};

module.exports = { resign, openPair, deviceOf, devicesOf, SIGNATURE_FILE: packaging.SIGNATURE_FILE };
