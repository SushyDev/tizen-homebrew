'use strict';

const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = require('fs');
const { dirname } = require('path');
const { tmpdir } = require('os');

process.env.HOMEBREW_CONFIG_DIR = mkdtempSync(`${tmpdir()}/homebrew-config-test-`);

const config = require('../src/config.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PAIR = { certificates: ['-----BEGIN CERTIFICATE-----\nQUFB\n-----END CERTIFICATE-----\n'], key: 'k' };

const drop = (value) => {
    mkdirSync(dirname(config.HANDOFF_PATH), { recursive: true });
    writeFileSync(config.HANDOFF_PATH, JSON.stringify(value));
};

check('nothing to adopt is not an error', config.adoptHandoff() === null, 'a missing hand-off threw');

{
    config.update({ catalogUrl: 'https://example.test/catalog.json', lastInstalled: [{ packageId: 'x' }] });

    drop({ author: PAIR, distributor: PAIR, devices: ['TESTSET1234', 'OTHERSET0001'] });

    const adopted = config.adoptHandoff();
    const stored = config.read();

    check('a dropped pair is adopted', adopted && adopted.join(',') === 'TESTSET1234,OTHERSET0001',
        JSON.stringify(adopted));

    check('and lands where resigning looks for it',
        stored.author.key === 'k' && stored.distributor.certificates.length === 1, JSON.stringify(stored.author));

    check('every device it names is kept, not just the first',
        stored.certDuids.join(',') === 'TESTSET1234,OTHERSET0001' && stored.certDuid === 'TESTSET1234',
        JSON.stringify(stored.certDuids));

    check('the television it covers may install', config.hasCertificates('TESTSET1234') === true, 'refused');
    check('one it does not is still refused', config.hasCertificates('NOTOURS0001') === false, 'allowed');

    check('and nothing else in the config was disturbed',
        stored.catalogUrl === 'https://example.test/catalog.json' && stored.lastInstalled.length === 1,
        JSON.stringify({ catalogUrl: stored.catalogUrl, lastInstalled: stored.lastInstalled }));

    check('the hand-off is consumed, so a restart does not repeat it',
        !existsSync(config.HANDOFF_PATH) && config.adoptHandoff() === null, 'the drop survived');
}

{
    config.forgetCertificates();

    drop({ author: PAIR });
    check('half a pair is refused rather than half-stored',
        config.adoptHandoff() === null && config.hasCertificates() === false, JSON.stringify(config.read().author));

    drop('placeholder');
    writeFileSync(config.HANDOFF_PATH, 'not json at all');
    check('an unreadable hand-off is ignored', config.adoptHandoff() === null, 'it threw');
}

{
    config.clear();
    config.update({ authorCert: 'base64', distributorCert: 'base64', password: 'p' });

    check('a pair from before PEM is not mistaken for a usable one',
        config.hasCertificates() === false, 'a .p12 config was accepted');

    check('and is recognizable, so the log can say why',
        config.hasLegacyCertificates() === true, 'the old shape went unnoticed');
}

config.clear();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
