'use strict';

const { existsSync, readFileSync } = require('fs');
const { join, dirname } = require('path');
const { homedir } = require('os');

const pkcs12 = require('../sdk/pkcs12.js');
const x509 = require('../sdk/x509.js');

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

const open = (path, password) => {
    if (!password || !existsSync(path)) return null;

    try {
        return pkcs12.read(readFileSync(path), password);
    } catch (e) {
        return null;
    }
};

const devicesIn = (path, password) => {
    const pair = open(path, password);

    return pair ? x509.devicesIn(pair.certificates) : [];
};

// Days left on the certificate that signs, which is the one that expires first and the one whose
// expiry is silent: a package signed with a lapsed pair uploads and is then refused at install.
const expiryOf = (path, password) => {
    const pair = open(path, password);

    return pair ? x509.expiresIn(pair.certificates[0]) : null;
};

const asPem = (bytes, password) => pkcs12.read(bytes, password);

const missing = (certificates) => [
    !existsSync(certificates.author) ? `no author certificate at ${certificates.author}` : null,
    !existsSync(certificates.distributor) ? `no distributor certificate at ${certificates.distributor}` : null,
    !certificates.password ? `no password — put it in ${certificates.passwordFile}, or set TIZEN_AUTHOR_PW` : null
].filter(Boolean);

const howToMint = () => 'Mint a pair bound to your television:\n\n' +
    '    npm run mint -- <tv-ip>             ask the TV which device it is\n' +
    '    npm run mint -- <tv-ip> <pin>       the same, once it is pinned to loopback\n' +
    '    npm run mint -- --duid <TV-DUID>    when you already know';

module.exports = { locate, missing, devicesIn, expiryOf, asPem, howToMint, DEFAULT_DIR };
