'use strict';

// The install sequence, exercised without a TV.
//
// Dependencies are injected precisely so this is possible: a fake sdb, a fake
// device and an in-memory config let the whole pipeline run against a real
// .wgt on a laptop. What is being pinned is the order of the steps and what
// happens when one of them refuses.

const { createInstaller } = require('../src/install/pipeline.js');
const { createStore } = require('../src/state.js');
const fixture = require('./fixture.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

// A real zip carrying the application's real manifest. See fixture.js for
// why this is built rather than read out of release/.
const realPackage = fixture.wgt();

// Tizen's service runtime calls module.exports.onStart(). Exporting anything
// else produces a service that installs, reports itself running, and never
// listens. That shipped once; it does not get to ship twice.
{
    const entry = require('../src/main.js');
    check('the service exports onStart, which Tizen calls',
        typeof entry.onStart === 'function', `exports: ${Object.keys(entry).join(', ')}`);
}

// --- doubles -------------------------------------------------------------

const fakeConfig = (initial = {}) => {
    let stored = { lastInstalled: [], ...initial };
    return {
        read: () => stored,
        update: (patch) => { stored = { ...stored, ...patch }; return stored; },
        hasCertificates: () => !!stored.authorCert,
        forgetCertificates: () => { stored = { ...stored, authorCert: null }; return stored; }
    };
};

const fakeSdb = (output = 'coreinstall spend time = 1234 ms') => ({
    withSession: (_options, run) => run({
        exec: () => Promise.resolve(output),
        close: () => {}
    })
});

// Holding certificates means every install is re-signed, so most of these
// need a resigner that behaves rather than one that refuses to be called.
const fakeResigner = () => Promise.resolve(async (archive) => ({
    archive, device: 'TESTSET', files: 1
}));

const fakeDevice = (state = {}) => ({
    probe: () => Promise.resolve({
        onTv: true, ready: true, needsResign: false, reason: null, ...state
    })
});

// Staging writes to /home/owner, which does not exist here, so the step is
// stubbed at the module boundary rather than the pipeline being changed for
// the benefit of its test.
const installer = require('../src/install/installer.js');
const realStage = installer.stage;
installer.stage = () => '/home/owner/share/tmp/sdk_tools/package.wgt';

const run = async () => {
    // --- the happy path, and the order of its steps ----------------------
    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('should not be needed')), store
        });

        const outcome = await install(
            { source: 'upload', reference: 'tizenhomebrew.wgt', upload: realPackage },
            (phase) => phases.push(phase)
        );

        check('an upload installs end to end',
            outcome.packageId === 'GJBBYNLkgP', JSON.stringify(outcome));
        check('the steps run in order',
            phases.join(' → ') === 'probing → fetching → staging → installing', phases.join(' → '));
        check('the store is released afterwards', store.select('installing') === false, 'still marked installing');
    }

    // --- one at a time ----------------------------------------------------
    {
        const store = createStore({ installing: true, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig(),
            resigner: () => {}, store
        });

        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('a second concurrent install is refused', refused.code === 'internal', String(refused.code));
    }

    // --- an unready TV stops before fetching anything ---------------------
    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ ready: false, reason: 'debugModeOff' }),
            config: fakeConfig(), resigner: () => {}, store
        });

        const refused = await install({ source: 'upload', upload: realPackage }, (p) => phases.push(p)).catch((e) => e);
        check('an unready TV refuses before fetching',
            refused.code === 'debugModeOff' && phases.join() === 'probing', `${refused.code} / ${phases}`);
        check('the store is released after a refusal', store.select('installing') === false, 'still marked installing');
    }

    // --- Tizen 7 without certificates -------------------------------------
    {
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ needsResign: true }), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('unreachable')), store
        });

        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('resigning without certificates is refused', refused.code === 'certsMissing', String(refused.code));
    }

    // --- a rejected certificate is discarded ------------------------------
    {
        const store = createStore({ installing: false, catalog: [] });
        const config = fakeConfig({ authorCert: 'present' });
        const { install } = createInstaller({
            sdb: fakeSdb('Check certificate error : :Check config.xml'),
            device: fakeDevice(), config, resigner: fakeResigner, store
        });

        const refused = await install({ source: 'upload', upload: realPackage }).catch((e) => e);
        check('a rejected certificate is dropped, not kept',
            refused.code === 'certRejected' && config.hasCertificates() === false,
            `${refused.code} / certs still held: ${config.hasCertificates()}`);
    }

    // --- certificates mean re-signing, whatever the firmware says --------
    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });
        const signed = [];

        const { install } = createInstaller({
            sdb: fakeSdb(),
            // needsResign false: an older television, which would accept the
            // package as it came.
            device: fakeDevice({ needsResign: false, duid: 'TESTSET' }),
            config: fakeConfig({ authorCert: 'present' }),
            resigner: () => Promise.resolve(async (archive) => {
                signed.push(archive.length);
                return { archive, device: 'TESTSET', files: 3 };
            }),
            store
        });

        await install({ source: 'upload', upload: realPackage }, (phase) => phases.push(phase));

        check('a package is re-signed even where the TV would not insist',
            signed.length === 1 && phases.indexOf('resigning') !== -1, phases.join(' → '));
    }

    // --- and without them, an older television still installs -------------
    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ needsResign: false }), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('should not be needed')), store
        });

        await install({ source: 'upload', upload: realPackage }, (phase) => phases.push(phase));

        check('with no certificates it installs the package as it came',
            phases.indexOf('resigning') === -1, phases.join(' → '));
    }

    installer.stage = realStage;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });
