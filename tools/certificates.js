'use strict';

// Where the signing certificates are, without being told every time.
//
// Packaging needs an author certificate, its password, and a distributor
// certificate — three things, and asking for all three as environment
// variables means a shell that forgets them between sessions and a README
// that spends four lines on exports before it gets to the point.
//
// So there is a default place to keep them, `~/.tizen-certs`, which is where
// `create-samsung-cert --output` is pointed in the README, and the password
// sits beside them in a file. Environment variables still win where they are
// set, because CI has no home directory to speak of.

const { existsSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const { homedir } = require('os');

const DEFAULT_DIR = join(homedir(), '.tizen-certs');

/**
 * The pair this machine would sign with, and where each part came from.
 *
 * Never throws: what is missing is more useful to a caller than an exception,
 * because `doctor` reports it and `package` refuses with it.
 */
const locate = () => {
    const author = process.env.TIZEN_AUTHOR_P12 || join(DEFAULT_DIR, 'author.p12');
    const beside = (name) => join(dirname(author), name);

    const passwordFile = beside('author.pw');

    const password = process.env.TIZEN_AUTHOR_PW ||
        (existsSync(passwordFile) ? readFileSync(passwordFile, 'utf8').trim() : null);

    return {
        author,
        // create-samsung-cert writes both halves side by side under one
        // password, so the second is found rather than configured.
        distributor: process.env.TIZEN_DISTRIBUTOR_P12 || beside('distributor.p12'),
        password,
        distributorPassword: process.env.TIZEN_DISTRIBUTOR_PW || password,
        passwordFile,
        directory: DEFAULT_DIR
    };
};

/**
 * Every television a distributor certificate covers.
 *
 * One certificate can name several — `--duidList` is a list — and that is what
 * makes a second TV cost a new distributor rather than a new everything.
 */
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

/** What is missing, in the order somebody would fix it. */
const missing = (certificates) => [
    !existsSync(certificates.author) ? `no author certificate at ${certificates.author}` : null,
    !existsSync(certificates.distributor) ? `no distributor certificate at ${certificates.distributor}` : null,
    !certificates.password ? `no password — put it in ${certificates.passwordFile}, or set TIZEN_AUTHOR_PW` : null
].filter(Boolean);

/** The instructions for making one, which every caller ends up printing. */
const howToMint = () => 'Mint a pair bound to your television:\n\n' +
    '    npm run mint -- <tv-ip>             ask the TV which device it is\n' +
    '    npm run mint -- <tv-ip> <pin>       the same, once it is pinned to loopback\n' +
    '    npm run mint -- --duid <TV-DUID>    when you already know';

module.exports = { locate, missing, devicesIn, howToMint, DEFAULT_DIR };
