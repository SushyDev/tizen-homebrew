'use strict';

const { existsSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const { homedir } = require('os');

const DEFAULT_DIR = join(homedir(), '.tizen-certs');

// `~/.tizen-certs` by default, with the password beside them. Environment variables still win,
// because CI has no home directory to speak of.
const locate = () => {
    const author = process.env.TIZEN_AUTHOR_P12 || join(DEFAULT_DIR, 'author.p12');
    const beside = (name) => join(dirname(author), name);

    const passwordFile = beside('author.pw');

    const password = process.env.TIZEN_AUTHOR_PW ||
        (existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : null);

    return {
        author,
        distributor: process.env.TIZEN_DISTRIBUTOR_P12 || beside('distributor.p12'),
        password,
        distributorPassword: process.env.TIZEN_DISTRIBUTOR_PW || password,
        passwordFile,
        directory: DEFAULT_DIR
    };
};

const devicesIn = (path, password) => {
    if (!password || !existsSync(path)) return [];

    try {
        const forge = require('node-forge');

        const p12 = forge.pkcs12.pkcs12FromAsn1(
            forge.asn1.fromDer(readFileSync(path).toString('binary')),
            false,
            password
        );

        return p12.safeContents
            .reduce((bags, contents) => bags.concat(contents.safeBags), [])
            .filter((bag) => bag.type === forge.pki.oids.certBag && bag.cert)
            .reduce((found, bag) => {
                const extension = bag.cert.getExtension('subjectAltName');

                return found.concat(((extension && extension.altNames) || [])
                    .map((name) => /deviceid=(.+)$/.exec(name.value || ''))
                    .filter(Boolean)
                    .map((match) => match[1]));
            }, [])
            .filter((device, index, all) => all.indexOf(device) === index);
    } catch (e) {
        return [];
    }
};

// The conversion happens here so it does not happen on the television: it was the only thing the
// service used node-forge for, and forge was a third of the bundle. The two `toPem` calls and their
// order are lifted verbatim from `tizen/src/packageSigner.js` — the signature is built from them.
const asPem = (der, password) => {
    const forge = require('node-forge');

    const p12 = forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(Buffer.from(der).toString('binary')),
        false,
        password
    );

    const certificates = [];
    let key = null;

    for (const contents of p12.safeContents) {
        for (const bag of contents.safeBags) {
            if (bag.type === forge.pki.oids.certBag && bag.cert) {
                certificates.push(forge.pki.certificateToPem(bag.cert));
            } else if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag && bag.key) {
                key = forge.pki.privateKeyToPem(bag.key);
            }
        }
    }

    if (!certificates.length) throw new Error('That certificate file holds no certificate.');
    if (!key) throw new Error('That certificate file holds no private key — wrong password?');

    return { certificates, key };
};

const missing = (certificates) => [
    !existsSync(certificates.author) ? `no author certificate at ${certificates.author}` : null,
    !existsSync(certificates.distributor) ? `no distributor certificate at ${certificates.distributor}` : null,
    !certificates.password ? `no password — put it in ${certificates.passwordFile}, or set TIZEN_AUTHOR_PW` : null
].filter(Boolean);

const howToMint = () => 'Mint a pair bound to your television:\n\n' +
    '    npm run mint -- <tv-ip>             ask the TV which device it is\n' +
    '    npm run mint -- <tv-ip> <pin>       the same, once it is pinned to loopback\n' +
    '    npm run mint -- --duid <TV-DUID>    when you already know';

module.exports = { locate, missing, devicesIn, asPem, howToMint, DEFAULT_DIR };
