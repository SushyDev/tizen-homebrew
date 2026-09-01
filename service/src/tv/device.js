'use strict';

const sdb = require('./sdb.js');
const { getJson } = require('../remote/fetch.js');

const DEVICE_API = 'http://127.0.0.1:8001/api/v2/';
const PROBE_TIMEOUT = 4000;

const RESIGN_REQUIRED_FROM = 7;

const onTv = typeof tizen !== 'undefined';

const platformVersion = () => {
    if (!onTv) return null;

    try {
        return tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
    } catch (e) {
        return null;
    }
};

// Runs on the shared connection, so a probe every fifteen seconds costs a stream rather than a socket.
// Two connect tries, not the default three: the probe also runs on page load and must answer quickly.
const canReachSdb = async () => {
    try {
        return await sdb.withSession({ timeout: 4000, attempts: 2 }, async (session) => {
            // A reply that is not a device id still proves the daemon is answering.
            const duid = await session.getDuid()
                .catch((error) => { if (error.code === 'sdbDuid') return null; throw error; });

            return { reachable: true, error: null, detail: null, duid };
        });
    } catch (error) {
        return { reachable: false, error: error.code || 'unknown', detail: error.message || null, duid: null };
    }
};

// Readiness is established by doing the thing: `developerIP` has reported 127.0.0.1 while sdbd refused.
const probe = async () => {
    const version = platformVersion();

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
        sdbDetail: null,
        ready: false,
        reason: null
    };

    if (!onTv) return { ...base, reason: 'notOnTv' };

    const reported = await (async () => {
        try {
            const { device } = await getJson(DEVICE_API, { timeout: PROBE_TIMEOUT });
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
        sdbDetail: sdbState.detail,
        ready: sdbState.reachable,
        reason
    };
};

module.exports = { probe, canReachSdb, platformVersion, onTv, RESIGN_REQUIRED_FROM };
