'use strict';

// What this service can find out about the TV it is running on.
//
// One rule governs this file: readiness is established by *doing the thing*,
// not by reading a setting that claims it would work.
//
// The device API's `developerIP` was trusted for that once. It reported
// 127.0.0.1 while sdbd was still only accepting a laptop, and reported it
// again while that laptop was successfully installing over sdb. Both times the
// screen confidently said the opposite of the truth. So it is not read here,
// and nothing derived from it is reported.

const sdb = require('./sdb.js');
const { getJson } = require('../remote/fetch.js');

const DEVICE_API = 'http://127.0.0.1:8001/api/v2/';
const PROBE_TIMEOUT = 4000;

// Tizen 7 rejects the author signature baked into a public release, so
// packages have to be re-signed against a certificate bound to this TV.
const RESIGN_REQUIRED_FROM = 7;

const onTv = typeof tizen !== 'undefined';

/** The platform version, or null when running off-TV. */
const platformVersion = () => {
    if (!onTv) return null;

    try {
        return tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
    } catch (e) {
        return null;
    }
};

/**
 * Ground truth: will sdbd accept a connection from the TV itself right now?
 *
 * This is the exact capability every install depends on, so it is the only
 * thing worth calling "ready".
 *
 * The DUID is read on the way past. It costs one command on a connection that
 * is being opened anyway, and it is what says whether the certificates stored
 * for re-signing belong to this television or to somebody else's — a question
 * whose wrong answer looks exactly like a working install until the moment the
 * TV refuses the package.
 */
const canReachSdb = async () => {
    try {
        const session = await sdb.connect({ timeout: 4000 });

        const duid = await session.getDuid().catch(() => null);

        session.close();

        return { reachable: true, error: null, duid };
    } catch (error) {
        return { reachable: false, error: error.code || 'unknown', duid: null };
    }
};

/**
 * A complete picture of the TV, safe to hand straight to a client.
 *
 * Never throws: an unreachable device API is a state the UI has to render, not
 * an exception to swallow. Every field is always present, so a consumer never
 * has to tell "false" apart from "this code path was not reached" — an
 * ambiguity that previously let a screen report the opposite of reality.
 */
const probe = async () => {
    const version = platformVersion();

    // Number('') is 0, not NaN, so an absent version would otherwise be
    // reported as major version zero rather than "unknown".
    const major = (() => {
        const first = String(version || '').split('.')[0];
        const parsed = Number(first);
        return first !== '' && !Number.isNaN(parsed) ? parsed : null;
    })();

    const base = {
        onTv,
        platformVersion: version,
        majorVersion: major,
        needsResign: major !== null && major >= RESIGN_REQUIRED_FROM,
        developerMode: null,
        deviceIp: null,
        duid: null,
        sdbReachable: false,
        sdbError: null,
        ready: false,
        reason: null
    };

    if (!onTv) return { ...base, reason: 'notOnTv' };

    const reported = await (async () => {
        try {
            const { device } = await getJson(DEVICE_API, { timeout: PROBE_TIMEOUT });
            // developerMode has held up; developerIP has not, and is not read.
            return { developerMode: device.developerMode === '1', deviceIp: device.ip || null };
        } catch (e) {
            return { developerMode: null, deviceIp: null };
        }
    })();

    const sdbState = await canReachSdb();

    const reason = sdbState.reachable ? null
        : reported.developerMode === false ? 'debugModeOff'
        : sdbState.error === 'sdbRefused' ? 'debugModeOff'
        : 'sdbUnreachable';

    return {
        ...base,
        ...reported,
        duid: sdbState.duid,
        sdbReachable: sdbState.reachable,
        sdbError: sdbState.error,
        ready: sdbState.reachable,
        reason
    };
};

module.exports = { probe, canReachSdb, platformVersion, onTv, RESIGN_REQUIRED_FROM };
