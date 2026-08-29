'use strict';

const { mkdtempSync, mkdirSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const appsRoot = mkdtempSync(join(tmpdir(), 'homebrew-apps-'));

mkdirSync(join(appsRoot, 'readable/res/wgt'), { recursive: true });
writeFileSync(join(appsRoot, 'readable/res/wgt/config.xml'),
    '<widget version="1.2.3"><name>Readable</name></widget>');

['silent1', 'silent2', 'silent3'].forEach((id) => mkdirSync(join(appsRoot, id), { recursive: true }));
mkdirSync(join(appsRoot, '.recovery'), { recursive: true });

const load = () => {
    delete require.cache[require.resolve('../src/tv/packages.js')];
    return require('../src/tv/packages.js');
};

const withTizen = (getAppsInfo, fn) => {
    global.tizen = { application: { getAppsInfo } };
    return Promise.resolve()
        .then(() => fn(load()))
        .then((value) => { delete global.tizen; return value; },
            (error) => { delete global.tizen; throw error; });
};

const byId = (list) => list.reduce((all, entry) => Object.assign(all, { [entry.id]: entry }), {});

const APPS = [
    { id: 'readable.App', packageId: 'readable', name: 'Readable', version: '1.2.3' },
    { id: 'silent1.App', packageId: 'silent1', name: 'First', version: '0.9.0' },
    { id: 'silent2.Service', packageId: 'silent2', name: 'Second Service', version: null },
    { id: 'silent2.App', packageId: 'silent2', name: 'Second', version: '4.0.1' }
];

const main = async () => {
    await withTizen((ok) => setTimeout(() => ok(APPS), 0), async (packages) => {
        const list = await packages.list({ appsRoot });
        const found = byId(list);

        check('every directory is a row, dotfiles excluded',
            list.length === 4 && !found['.recovery'], `${list.length}: ${Object.keys(found)}`);

        check('the platform supplies a version the manifest could not',
            found.silent1.version === '0.9.0' && found.silent1.name === 'First',
            JSON.stringify(found.silent1));

        check('one package, several applications: the versioned one wins',
            found.silent2.version === '4.0.1', JSON.stringify(found.silent2));

        check('a package the platform did not name still lists, with no version',
            found.silent3.version === null && found.silent3.name === 'silent3',
            JSON.stringify(found.silent3));

        check('a readable manifest agrees with the platform',
            found.readable.version === '1.2.3', JSON.stringify(found.readable));
    });

    await withTizen((ok) => ok([APPS[0]]), async (packages) => {
        const list = await packages.list({ appsRoot });

        check('a short answer from the platform does not lose rows',
            list.length === 4, `${list.length} rows`);

        check('the packages it left out fall back to their manifests',
            byId(list).readable.version === '1.2.3' && byId(list).silent1.version === null,
            JSON.stringify(byId(list).silent1));
    });

    await withTizen((ok, fail) => fail(new Error('nope')), async (packages) => {
        const list = await packages.list({ appsRoot });

        check('a refusal falls back to the disk alone',
            list.length === 4 && byId(list).readable.version === '1.2.3', `${list.length} rows`);
    });

    await withTizen(() => { throw new Error('threw synchronously'); }, async (packages) => {
        const list = await packages.list({ appsRoot });

        check('a throwing device api is caught, not propagated', list.length === 4, `${list.length} rows`);
    });

    await withTizen(() => {}, async (packages) => {
        const started = Date.now();
        const said = [];
        const say = { debug: () => {}, info: (line) => said.push(line) };

        const list = await packages.list({ appsRoot, say });
        const elapsed = Date.now() - started;

        check('a silent device api gives up on its deadline',
            list.length === 4 && elapsed >= packages.NAMING_DEADLINE && elapsed < packages.NAMING_DEADLINE + 2000,
            `${list.length} rows in ${elapsed}ms`);

        check('and says so once, naming the call',
            said.length === 1 && /getAppsInfo/.test(said[0]), JSON.stringify(said));

        const again = Date.now();
        await packages.list({ appsRoot, say });

        check('and is not asked a second time', Date.now() - again < 1000, `${Date.now() - again}ms`);
    });

    {
        const packages = load();
        const refused = await packages.list({ appsRoot }).then(() => null, (error) => error);

        check('off a television, listing is refused rather than empty',
            refused && refused.code === 'notOnTv', String(refused));
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
