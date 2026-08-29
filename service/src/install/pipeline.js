'use strict';

// Installing something, start to finish.
//
// This is the centre of Tizen Homebrew, and it is meant to be read top to bottom:
// six named steps, each taking the work so far and returning it further along.
// Every route into the service — the phone UI, an upload from a laptop, a
// catalogue entry — runs this same sequence, so none of them can drift into
// having its own subtly different idea of what installing means.

const { createHash } = require('crypto');

const sources = require('./sources.js');
const manifest = require('./manifest.js');
const preview = require('./preview.js');
const installer = require('./installer.js');
const { size, took, rate } = require('../obs/units.js');
const memory = require('../obs/memory.js');

const refuse = (code, message) => Object.assign(new Error(message), { code });

// Nothing is silent. Where no reporter is handed in — the tests — the calls
// still happen and go nowhere, so the sequence below reads the same either way.
const QUIET = ['debug', 'info', 'ok', 'warn', 'err']
    .reduce((noop, level) => ({ ...noop, [level]: () => {} }), {});

/**
 * Builds the installer.
 *
 * Dependencies are passed in rather than required here so the sequence can be
 * exercised without a TV: the tests supply their own `sdb` and `device`.
 */
const createInstaller = ({ sdb, device, config, resigner, store, log }) => {
    const say = log ? log.on('pkg') : QUIET;
    const sdbSays = log ? log.on('sdb') : QUIET;

    /**
     * Runs one install.
     *
     * `report(phase, detail, extra)` is called as each step begins — that is
     * what becomes progress on a phone screen. `extra` carries the one thing a
     * phase word cannot: `{ identity }`, once there is a package to identify.
     * `request` names the source; nothing else about it reaches the steps
     * below.
     */
    const install = async (request, report = () => {}) => {
        if (store.select('installing')) {
            say.warn('refused: an install is already running');
            throw refuse('internal', 'An install is already running.');
        }

        store.update({ installing: true });

        const held = memory.peak();
        const phase = (name, detail, extra) => {
            held.at(name);
            report(name, detail, extra);
        };

        // Every line below is timed from here, so the log answers "which step
        // was slow" without anybody having to subtract timestamps.
        const startedAt = Date.now();
        const at = () => Date.now() - startedAt;

        say.info(`install requested: ${request.source} ${request.reference || '(upload)'}`);

        const probeReadiness = async () => {
            phase('probing');

            const state = await device.probe();

            say.info(state.onTv
                ? `television is tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ', which requires re-signed packages' : ''}` +
                  `, sdb ${state.ready ? 'reachable' : `unreachable — ${state.sdbDetail || state.sdbError || state.reason || 'unknown'}`}`
                : 'no television here — running as a development harness');

            // Off-TV this is a development harness, and there is nothing to
            // install onto; on a TV, an unreachable sdb means nothing can work.
            if (state.onTv && !state.ready) {
                // The refusal carries what sdbd actually said. A person
                // reading "set the developer host IP to 127.0.0.1" on a set
                // where it is already 127.0.0.1 learns nothing and mistrusts
                // the next message too, so the remedy comes after the fault
                // and only as the thing that would explain it.
                throw refuse(
                    state.reason === 'debugModeOff' ? 'debugModeOff' : 'sdbUnreachable',
                    `${state.sdbDetail || `sdb was unreachable (${state.sdbError || state.reason || 'unknown'})`} ` +
                    (state.reason === 'debugModeOff'
                        ? 'Developer Mode is off in Apps › 12345 › Settings.'
                        : 'If it stays this way, Host PC IP = 127.0.0.1 and a restart is what fixes a misconfigured one.')
                );
            }

            return { state };
        };

        const acquirePackage = async (carried) => {
            phase('fetching', request.reference || request.source);

            const began = Date.now();

            const { archive, name } = await sources.resolve({
                ...request,
                catalog: store.select('catalog') || [],
                log
            });

            const spent = Date.now() - began;

            // The digest is what makes "the same build" a checkable claim
            // rather than a hope, and it is the only way to tell a truncated
            // download from a short one after the fact.
            say.ok(`got ${name}: ${size(archive.length)} in ${took(spent)} (${rate(archive.length, spent)})`);
            say.info(`sha256 ${createHash('sha256').update(archive).digest('hex').slice(0, 16)}…`);

            return { ...carried, archive, name };
        };

        // Read off the archive exactly as it arrived, before it is re-signed.
        //
        // Re-signing replaces the two signature files and touches nothing
        // else, so this is the same answer a step later — and a step earlier
        // is where it is worth having, because it is what the phase below
        // sends. It also means a file that is not a Tizen package at all is
        // refused before anything spends 150ms signing it, with a message
        // that names the actual problem rather than a zip that would not open.
        //
        // `described` is the same identity with the application's own icon
        // pulled out of the archive beside it — see install/preview.js. That
        // is the phone's copy; the bare identity is what the steps below
        // install under.
        const readIdentity = (carried) => {
            const identity = manifest.identify(carried.archive);

            say.info(`identified ${identity.name || 'an unnamed package'} ${identity.version || ''} ` +
                `(${identity.packageId}${identity.appId ? `, app ${identity.appId}` : ''}, ${identity.isWgt ? 'wgt' : 'tpk'})`);

            return { ...carried, identity, described: preview.describe(carried.archive, identity) };
        };

        // Always re-signed with this television's own pair. Every source —
        // the catalogue, an upload, a GitHub release, a stick in the side of
        // the set — arrives here and leaves signed by the same certificate.
        //
        // There used to be a way past this: below Tizen 7 a set with no stored
        // pair installed the package exactly as it came, carrying whoever's
        // signature it was built with. That is the one path where what ends up
        // on a television is not something this machine signed, and it failed
        // in the least useful way available — the install ran, the set refused
        // it at the end, and the reason named a certificate nobody here chose.
        //
        // From Tizen 7 the set checks the distributor certificate was minted
        // for it, so re-signing was already the only way anything installed at
        // all. Below that it is the difference between "packages this
        // television's owner signed" and "packages", which is worth 150ms.
        const resign = async (carried) => {
            // The identity goes out with this phase, which is the first one
            // after the bytes are in hand. Until here whatever asked for the
            // install has had nothing but the reference it typed — a repo
            // name, a URL, a filename off a stick — and the two steps left are
            // the slow ones to sit through looking at that. So the screen
            // showing "SushyDev/tizen-homebrew" becomes the screen showing
            // Tizen Homebrew, with its own icon on it, before the signing
            // starts rather than after it.
            //
            // Before the certificate check, deliberately: a set with no pair
            // stored refuses here, and a refusal that names the application it
            // refused is worth more than one naming the file it arrived in.
            phase('resigning', carried.identity.name || carried.identity.packageId,
                { identity: carried.described });

            if (!config.hasCertificates(carried.state.duid)) {
                throw refuse('certsMissing',
                    'Packages are signed with this TV\'s own certificate pair, and none is ' +
                    'stored yet. Send one first — see `npm run certs`.');
            }

            const sign = await resigner();
            const { archive, device, files } = await sign(carried.archive);

            say.ok(`re-signed ${files} files for ${device || 'this television'}`);

            return { ...carried, archive };
        };

        const stageOnDisk = (carried) => {
            phase('staging', carried.identity.name || carried.identity.packageId);

            const stagedPath = installer.stage(carried.archive, carried.identity);

            say.ok(`staged ${size(carried.archive.length)} to ${stagedPath}`);

            return { ...carried, stagedPath };
        };

        const runInstaller = async (carried) => {
            phase('installing', carried.identity.name || carried.identity.packageId);

            const command = `shell:0 vd_appinstall ${carried.identity.packageId} ${carried.stagedPath}`;
            const began = Date.now();

            sdbSays.info(command);

            const result = await sdb.withSession({}, (session) =>
                installer.run(session, carried.stagedPath, carried.identity.packageId));

            // vd_appinstall's own verdict, verbatim. It is the one sentence
            // that says what the *television* thought of the package, and
            // paraphrasing it has cost hours before now.
            const verdict = String((result && result.output) || '')
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .pop();

            if (verdict) sdbSays.info(verdict);
            sdbSays.ok(`vd_appinstall finished in ${took(Date.now() - began)}`);

            return carried;
        };

        const recordOutcome = (carried) => {
            const { packageId, appId, name, version } = carried.identity;

            const previous = (config.read().lastInstalled || [])
                .filter((entry) => entry.packageId !== packageId);

            config.update({
                lastInstalled: [{ packageId, appId, name, version, at: new Date().toISOString() }]
                    .concat(previous)
                    .slice(0, 20)
            });

            return { packageId, appId, name, version };
        };

        try {
            const readied = await probeReadiness();
            const acquired = await acquirePackage(readied);
            const identified = readIdentity(acquired);
            const signed = await resign(identified);
            const staged = stageOnDisk(signed);
            const installed = await runInstaller(staged);
            const outcome = recordOutcome(installed);

            held.at('finishing');

            say.ok(`installed ${outcome.name || outcome.packageId} ${outcome.version || ''} in ${took(at())}`);

            return outcome;
        } catch (error) {
            say.err(`install failed after ${took(at())}: ${error.code || 'internal'} — ${error.message}`);

            // What to do about it, when the failure is one verdicts.js knows.
            // It reaches the phone in the error payload; putting it in the log
            // too means somebody reading the log console has the answer in
            // front of them rather than the verdict alone.
            if (error.remedy) error.remedy.split('\n').forEach((line) => say.warn(line));

            // Certificates the TV rejected are worse than none: they make every
            // later attempt fail identically. Dropping them means the next one
            // re-mints rather than repeating the failure.
            if (error.code === 'certRejected') {
                say.warn('clearing the stored certificates so the next attempt re-mints them');
                config.forgetCertificates();
            }

            throw error;
        } finally {
            // Logged whether it worked or not: an install that ran out of
            // memory and one the set refused read the same without it.
            const high = held.highest();

            if (high.at) {
                // getrusage's peak covers the whole process life, not this install.
                say.info(`peak memory ${memory.describe(high)}, at ${high.at}` +
                    (high.peakRss ? `; process high-water ${size(high.peakRss)}` : ''));
            }

            store.update({ installing: false });
        }
    };

    return { install };
};

module.exports = { createInstaller };
