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

    // And onRequest, which Tizen calls for an app control request delivered to
    // a service that is already running — every launch of the app after the
    // first. Without it the runner threw `app.onRequest is not a function`
    // into the service on each one, and the stack trace landed in the log.
    check('and onRequest, which it calls on every launch after the first',
        typeof entry.onRequest === 'function', `exports: ${Object.keys(entry).join(', ')}`);
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
        const announced = [];
        const store = createStore({ installing: false, catalog: [] });

        // Certificates, because there is no install without them any more:
        // every package is signed with this television's own pair before it
        // reaches the installer, whatever the firmware and whatever it came
        // signed with.
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice(), config: fakeConfig({ authorCert: 'present' }),
            resigner: fakeResigner, store
        });

        const outcome = await install(
            // With its icon in it: the identity this announces is what a phone
            // draws a card from, and half of that card is the picture.
            { source: 'upload', reference: 'tizenhomebrew.wgt', upload: fixture.wgtWithIcon() },
            (phase, _detail, extra) => {
                phases.push(phase);
                if (extra && extra.identity) announced.push([phase, extra.identity]);
            }
        );

        check('an upload installs end to end',
            outcome.packageId === 'GJBBYNLkgP', JSON.stringify(outcome));
        check('the steps run in order',
            phases.join(' → ') === 'probing → fetching → resigning → staging → installing', phases.join(' → '));
        check('the store is released afterwards', store.select('installing') === false, 'still marked installing');

        // Whatever asked for the install has had nothing but the reference it
        // typed up to this point. The identity is what lets a phone stop
        // showing a filename and start showing the application — see
        // install/preview.js — and it has to arrive while the install is still
        // running, not with the outcome.
        //
        // With re-signing, specifically: that is the first phase after the
        // download, and the two steps after it are the slow ones. Announcing
        // any later means sitting through them looking at a filename, which is
        // where this used to be.
        check('the package announces what it is, once, as it is signed',
            announced.length === 1 &&
            announced[0][0] === 'resigning' &&
            announced[0][1].packageId === 'GJBBYNLkgP' &&
            announced[0][1].name === 'Tizen Homebrew',
            JSON.stringify(announced));

        // And it carries the application's own icon, pulled out of the same
        // archive — the whole reason the phone can show the app rather than
        // the name of the file it arrived in.
        check('with the icon out of the archive on it',
            String(announced[0][1].icon || '').startsWith('data:image/png;base64,'),
            String(announced[0][1].icon).slice(0, 40));
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
        const announced = [];
        const store = createStore({ installing: false, catalog: [] });
        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ needsResign: true }), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('unreachable')), store
        });

        const refused = await install(
            { source: 'upload', upload: realPackage },
            (phase, _detail, extra) => { if (extra && extra.identity) announced.push([phase, extra.identity]); }
        ).catch((e) => e);

        check('a Tizen 7 set without certificates is refused', refused.code === 'certsMissing', String(refused.code));

        // The announcement is made before the certificate check rather than
        // after it, so a refusal names the application it refused rather than
        // the file it happened to arrive in.
        check('and the package still said what it was first',
            announced.length === 1 && announced[0][0] === 'resigning' &&
            announced[0][1].name === 'Tizen Homebrew',
            JSON.stringify(announced));
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
            // needsResign false: an older television, which does not check the
            // distributor certificate and is re-signed for anyway.
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

    // --- and without them, nothing installs at all ------------------------
    //
    // An older television used to take the package exactly as it came, which
    // meant the one thing on the set this machine had not signed. It failed at
    // the far end, minutes later, naming a certificate nobody here chose.
    {
        const phases = [];
        const store = createStore({ installing: false, catalog: [] });

        const { install } = createInstaller({
            sdb: fakeSdb(), device: fakeDevice({ needsResign: false }), config: fakeConfig(),
            resigner: () => Promise.reject(new Error('should not be needed')), store
        });

        const refused = await install({ source: 'upload', upload: realPackage },
            (phase) => phases.push(phase)).catch((e) => e);

        check('no certificates is refused on any firmware, not just Tizen 7',
            refused.code === 'certsMissing', String(refused.code));

        check('and nothing unsigned by us reaches the installer',
            phases.indexOf('installing') === -1, phases.join(' → '));
    }

    installer.stage = realStage;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

run().catch((error) => { console.error('Harness error:', error); process.exit(1); });
