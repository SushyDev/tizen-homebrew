'use strict';

const { mkdtempSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const platform = require('../src/obs/platform.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const extensionsDir = mkdtempSync(join(tmpdir(), 'homebrew-xwalk-'));

['libtizen.so', 'libtizen_application.so', 'libtizen_sensor.so', 'libtizen_tvaudio.so',
    'libwebapis_sa.so', 'README'].forEach((name) => writeFileSync(join(extensionsDir, name), ''));

const LWNODE = {
    lwnode: {
        MemWatcher: () => {},
        PssUsage: () => {},
        _print: () => {},
        hasSystemInfo: (key) => key === 'tizen' || key === 'appid'
    }
};

{
    const names = ['libtizen.so', 'libtizen_sensor.so', 'libtizen_tvaudio.so',
        'libtizen_messageport.so', 'libwebapis_sa.so', 'libtizen_x.dll', 'README']
        .map(platform.namespaceOf);

    check('the three irregular library names map to their real namespaces',
        names[0] === 'tizen' && names[1] === 'tizen.sensorservice' && names[2] === 'tizen.tvaudiocontrol',
        JSON.stringify(names.slice(0, 3)));

    check('the plain rule covers everything else',
        names[3] === 'tizen.messageport' && names[4] === 'webapis.sa', JSON.stringify(names.slice(3, 5)));

    check('anything that is not an extension is not one', names[5] === null && names[6] === null,
        JSON.stringify(names.slice(5)));
}

const main = async () => {
    {
        const facts = await platform.describe({
            proc: LWNODE,
            globals: {
                tizen: { application: {}, systeminfo: {}, TZDate: {} },
                webapis: {
                    sa: {},
                    productinfo: {
                        getRealModel: () => 'QE65S93DATXXN',
                        getFirmware: () => 'T-PTMDDEUC-0090-2130.0',
                        getDuid: () => 'PC3JB2FQOGHRT'
                    }
                }
            },
            extensionsDir,
            lwnodeBinary: join(extensionsDir, 'libtizen.so')
        });

        check('process.lwnode is reported present, with its public methods only',
            facts.lwnode.present && facts.lwnode.methods.join(',') === 'MemWatcher,PssUsage,hasSystemInfo',
            JSON.stringify(facts.lwnode));

        check('hasSystemInfo("appid") says it was launched as a tizen app',
            facts.lwnode.asTizenApp === true, String(facts.lwnode.asTizenApp));

        check('a missing Intl is reported as missing', facts.intl === false, String(facts.intl));

        check('the extension directory is the device-api inventory',
            facts.deviceApis.available.join(' ') ===
                'tizen tizen.application tizen.sensorservice tizen.tvaudiocontrol webapis.sa',
            facts.deviceApis.available.join(' '));

        check('bound namespaces are read from the globals, not the directory',
            facts.deviceApis.bound.tizen.join(' ') === 'TZDate application systeminfo' &&
            facts.deviceApis.bound.webapis.join(' ') === 'productinfo sa',
            JSON.stringify(facts.deviceApis.bound));

        const lines = platform.summary(facts);

        check('the set names itself first, which is what a bug report needs',
            lines[0] === 'QE65S93DATXXN, firmware T-PTMDDEUC-0090-2130.0', lines[0]);

        check('and the productinfo duid is never read',
            !JSON.stringify(facts).includes('PC3JB2FQOGHRT'), JSON.stringify(facts.identity));

        lines.shift();

        check('the summary names the engine facts a reader would go looking for',
            /process\.lwnode present/.test(lines[0]) && /Intl ABSENT/.test(lines[0]), lines[0]);

        check('constructors are counted apart from namespaces',
            /5 device apis on this firmware; bound here: 2 tizen, 2 webapis, 1 constructors/.test(lines[1]),
            lines[1]);

        check('and both hosts are named in full',
            lines[2] === 'tizen: application systeminfo' && lines[3] === 'webapis: productinfo sa',
            JSON.stringify(lines.slice(2)));
    }

    {
        let touched = 0;
        const globals = { tizen: {}, Intl: {} };

        ['application', 'filesystem'].forEach((name) => Object.defineProperty(globals.tizen, name, {
            enumerable: true,
            get: () => { touched += 1; return {}; }
        }));

        const facts = await platform.describe({ proc: {}, globals, extensionsDir });

        check('namespaces are enumerated without being loaded',
            touched === 0 && facts.deviceApis.bound.tizen.length === 2, `${touched} properties read`);

        check('no process.lwnode is a fact, not a failure',
            facts.lwnode.present === false && facts.lwnode.methods.length === 0, JSON.stringify(facts.lwnode));
    }

    {
        const facts = await platform.describe({
            proc: {}, globals: {}, extensionsDir: '/definitely/not/here'
        });

        check('an unreadable extension directory is null, not empty',
            facts.deviceApis.available === null, JSON.stringify(facts.deviceApis.available));

        check('and the summary says so rather than printing an empty list',
            /no \/definitely\/not\/here/.test(platform.summary(facts)[1]), platform.summary(facts)[1]);
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
