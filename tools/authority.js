'use strict';

// Rewrites sdk/authority.js from the Samsung Certificate Extension. Run it when Samsung rotates a
// certificate authority; nothing else in this repository reaches download.tizen.org.

const { writeFileSync, readFileSync } = require('fs');
const { join } = require('path');

const JSZip = require('jszip');

const ui = require('./ui.js');
const x509 = require('../sdk/x509.js');

const INFO = 'https://download.tizen.org/sdk/tizenstudio/official/extension_info.xml';

const MODULE = join(__dirname, '..', 'sdk', 'authority.js');

const WANTED = [
    { constant: 'AUTHOR', file: 'vd_tizen_dev_author_ca.cer' },
    { constant: 'PUBLIC', file: 'vd_tizen_dev_public2.crt' },
    { constant: 'PARTNER', file: 'vd_tizen_dev_partner2.crt' }
];

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const get = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) });

    if (!response.ok) throw friendly(`${url} answered ${response.status}.`);

    return Buffer.from(await response.arrayBuffer());
};

// The repository URL is announced in extension_info.xml rather than being a version we pin.
const repository = (xml) => {
    const block = xml.split('<extension').find((part) => part.indexOf('Samsung Certificate Extension') !== -1);
    const found = block && /<repository>\s*([^<\s]+)\s*<\/repository>/.exec(block);

    if (!found) throw friendly('extension_info.xml no longer announces the Samsung Certificate Extension.');

    return found[1];
};

// A zip holding a zip holding a jar, and the certificates are files in the jar.
const certificatesIn = async (archive) => {
    const outer = await JSZip.loadAsync(archive);
    const addon = Object.keys(outer.files).find((name) => name.endsWith('.zip'));

    const inner = await JSZip.loadAsync(await outer.files[addon].async('nodebuffer'));

    const jarName = Object.keys(inner.files).find((name) => /certificate-manager.*\.jar$/.test(name))
        || Object.keys(inner.files).find((name) => name.endsWith('.jar'));

    const jar = await JSZip.loadAsync(await inner.files[jarName].async('nodebuffer'));

    const named = WANTED.map((entry) => entry.file);

    return Object.keys(jar.files)
        .filter((name) => named.indexOf(name.split('/').pop()) !== -1)
        .reduce(async (waiting, name) => ({
            ...await waiting,
            [name.split('/').pop()]: (await jar.files[name].async('string')).trim()
        }), Promise.resolve({}));
};

const rewrite = (found) => {
    const before = readFileSync(MODULE, 'utf8');
    const after = WANTED.reduce(
        (text, entry) => text.replace(
            new RegExp(`const ${entry.constant} = \`[^\`]*\``),
            `const ${entry.constant} = \`${found[entry.file]}\``
        ),
        before
    );

    writeFileSync(MODULE, after);

    return before !== after;
};

const main = async () => {
    ui.heading('authority');
    ui.blank();

    const url = repository((await get(INFO)).toString('utf8'));
    ui.info('extension', url);

    const found = await certificatesIn(await get(url));
    const missing = WANTED.filter((entry) => !found[entry.file]);

    if (missing.length) {
        throw friendly(`The extension no longer carries ${missing.map((entry) => entry.file).join(', ')}.`);
    }

    const changed = rewrite(found);

    WANTED.forEach((entry) => {
        const described = x509.describe(found[entry.file]);

        ui.ok(entry.constant.toLowerCase(), `${described.subject} · ${x509.expiresIn(found[entry.file])} days left`);
    });

    ui.blank();
    ui.note(changed
        ? 'sdk/authority.js changed — run `npm test` and commit it.'
        : 'sdk/authority.js was already current.');
    ui.blank();
};

main().catch((err) => ui.crash(err));
