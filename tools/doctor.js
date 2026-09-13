'use strict';

const { existsSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const { load, CONFIG_PATH, ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const authority = require('../sdk/authority.js');
const x509 = require('../sdk/x509.js');

const checks = [];

function check(name, fn) {
    try {
        const result = fn();
        if (result && result.skip) return checks.push({ name, state: 'skip', detail: result.detail });
        checks.push({ name, state: 'ok', detail: result && result.detail });
    } catch (e) {
        checks.push({ name, state: 'fail', detail: e.message });
    }
}

check('Node.js >= 20', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) {
        throw new Error(`Found Node ${process.versions.node}. Install Node 20 or newer (see .nvmrc).`);
    }
    return { detail: `v${process.versions.node}` };
});

check('dependencies installed', () => {
    if (!existsSync(join(ROOT, 'node_modules'))) {
        throw new Error('No node_modules. Run: npm install');
    }
    const probes = ['vite', 'rolldown', 'ws', 'acorn', 'eslint', 'jszip'];
    const missing = probes.filter((name) => !existsSync(join(ROOT, 'node_modules', name)));
    if (missing.length) {
        throw new Error(`Missing ${missing.join(', ')}. Run: npm install`);
    }
    return { detail: `${probes.length} key packages present` };
});

check('tizen.config.json', () => {
    const config = load();
    if (config.placeholders.length) {
        return { detail: `valid, but ${config.placeholders.join(' and ')} still points at an example host` };
    }
    return { detail: `version ${config.version}` };
});

check('signing authorities bundled', () => {
    const lapsed = ['author', 'Public', 'Partner']
        .map((which) => (which === 'author' ? authority.authorCa() : authority.distributorCa(which)))
        .map((pem) => ({ name: x509.describe(pem).subject, days: x509.expiresIn(pem) }))
        .filter((entry) => entry.days <= 0);

    if (lapsed.length) {
        throw new Error(`${lapsed.map((entry) => entry.name).join(', ')} expired. Run: npm run authority`);
    }

    return { detail: 'Samsung VD author, public and partner' };
});

check('signing certificate (packaging only)', () => {
    const found = certificates.locate();
    const absent = certificates.missing(found);

    if (absent.length === 3) {
        return {
            skip: true,
            detail: `none in ${found.directory} — needed only for \`npm run package -- --sign\`.`
        };
    }

    if (absent.length) throw new Error(absent.join('; '));

    const p12 = found.author;

    const distributor = found.distributor;
    if (!existsSync(distributor)) {
        throw new Error(
            `No distributor certificate at ${distributor}.\n` +
            '      Mint one: npm run mint -- <tv-ip>'
        );
    }

    const devices = certificates.devicesIn(distributor, found.distributorPassword);
    const days = certificates.expiryOf(p12, found.password);

    if (days !== null && days <= 0) {
        throw new Error('The author certificate has expired — packages signed with it are refused at install.');
    }

    const covering = devices.length ? devices.join(', ') : 'no television — the pair names none';

    return {
        detail: `${covering}${days === null ? '' : ` · ${days} days left`}`
    };
});

ui.heading('doctor', CONFIG_PATH.replace(`${ROOT}/`, ''));
ui.blank();

checks.forEach((entry) => {
    if (entry.state === 'ok') ui.ok(entry.name, entry.detail);
    else if (entry.state === 'skip') ui.warn(`${entry.name}\n      ${entry.detail}`);
    else ui.fail(entry.name, entry.detail);
});

const failed = checks.filter((c) => c.state === 'fail');
ui.blank();

if (failed.length) {
    ui.note(`${failed.length} problem${failed.length === 1 ? '' : 's'} to fix before building.`);
    process.exit(1);
}

ui.note('Ready to build.  npm run build');
ui.blank();
