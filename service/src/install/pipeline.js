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
const installer = require('./installer.js');
const { size, took, rate } = require('../obs/units.js');

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
     * `report(phase, detail)` is called as each step begins — that is what
     * becomes progress on a phone screen. `request` names the source; nothing
     * else about it reaches the steps below.
     */
    const install = async (request, report = () => {}) => {
        if (store.select('installing')) {
            say.warn('refused: an install is already running');
            throw refuse('internal', 'An install is already running.');
        }

        store.update({ installing: true });

        // Every line below is timed from here, so the log answers "which step
        // was slow" without anybody having to subtract timestamps.
        const startedAt = Date.now();
        const at = () => Date.now() - startedAt;

        say.info(`install requested: ${request.source} ${request.reference || '(upload)'}`);

        const probeReadiness = async () => {
            report('probing');

            const state = await device.probe();

            say.info(state.onTv
                ? `television is tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ', which requires re-signed packages' : ''}` +
                  `, sdb ${state.ready ? 'reachable' : `unreachable (${state.sdbError || state.reason || 'unknown'})`}`
                : 'no television here — running as a development harness');

            // Off-TV this is a development harness, and there is nothing to
            // install onto; on a TV, an unreachable sdb means nothing can work.
            if (state.onTv && !state.ready) {
                throw refuse(
                    state.reason === 'debugModeOff' ? 'debugModeOff' : 'sdbUnreachable',
                    state.reason === 'debugModeOff'
                        ? 'Developer Mode is off on this TV.'
                        : 'This TV cannot reach its own sdb daemon. Set the developer host IP to 127.0.0.1 and restart the TV.'
                );
            }

            return { state };
        };

        const acquirePackage = async (carried) => {
            report('fetching', request.reference || request.source);

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

        // Re-signed whenever there is a certificate to do it with, not only
        // when the television insists.
        //
        // From Tizen 7 the set checks that the distributor certificate was
        // minted for it, so re-signing is the only way anything installs at
        // all. Below that it is merely the difference between "packages this
        // particular developer signed" and "packages" — an unsigned build, or
        // one signed for somebody else's TV, is refused just the same, and a
        // signature this television already trusts costs 150ms to apply.
        const resignIfRequired = async (carried) => {
            const stored = config.hasCertificates(carried.state.duid);

            if (!stored) {
                if (!carried.state.needsResign) {
                    say.info('no certificates stored — installing the package as it came');
                    return carried;
                }

                throw refuse('certsMissing',
                    'This TV runs Tizen 7 or newer, so packages must be re-signed for it. ' +
                    'Send it a certificate pair first — see `npm run certs`.');
            }

            report('resigning');

            const resign = await resigner();
            const { archive, device, files } = await resign(carried.archive);

            say.ok(`re-signed ${files} files for ${device || 'this television'}`);

            return { ...carried, archive };
        };

        const readIdentity = (carried) => {
            const identity = manifest.identify(carried.archive);

            report('staging', identity.name || identity.packageId);
            say.info(`identified ${identity.name || 'an unnamed package'} ${identity.version || ''} ` +
                `(${identity.packageId}${identity.appId ? `, app ${identity.appId}` : ''}, ${identity.isWgt ? 'wgt' : 'tpk'})`);

            return { ...carried, identity };
        };

        const stageOnDisk = (carried) => {
            const stagedPath = installer.stage(carried.archive, carried.identity);

            say.ok(`staged ${size(carried.archive.length)} to ${stagedPath}`);

            return { ...carried, stagedPath };
        };

        const runInstaller = async (carried) => {
            report('installing', carried.identity.name || carried.identity.packageId);

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
            const signed = await resignIfRequired(acquired);
            const staged = stageOnDisk(readIdentity(signed));
            const installed = await runInstaller(staged);
            const outcome = recordOutcome(installed);

            say.ok(`installed ${outcome.name || outcome.packageId} ${outcome.version || ''} in ${took(at())}`);

            return outcome;
        } catch (error) {
            say.err(`install failed after ${took(at())}: ${error.code || 'internal'} — ${error.message}`);

            // Certificates the TV rejected are worse than none: they make every
            // later attempt fail identically. Dropping them means the next one
            // re-mints rather than repeating the failure.
            if (error.code === 'certRejected') {
                say.warn('clearing the stored certificates so the next attempt re-mints them');
                config.forgetCertificates();
            }

            throw error;
        } finally {
            store.update({ installing: false });
        }
    };

    return { install };
};

module.exports = { createInstaller };
