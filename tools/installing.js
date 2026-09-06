'use strict';

// The install itself, with no checkout behind it. `bootstrap` reads a .wgt built here and the
// standalone installer downloads a released one; past that point the two are the same, so the
// sync push, the verdict reading and the confirmation live in one place.
//
// Nothing in here prints. The caller passes `on` handlers for the steps worth narrating, because
// the CLI and the guided installer say different things about the same events.

const JSZip = require('jszip');

const sdb = require('../service/src/tv/sdb.js');
const verdicts = require('../service/src/install/verdicts.js');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';

// Must match service/src/config.js. In the staging directory because sdb refuses the rest of share/.
const HANDOFF_PATH = `${STAGING_DIR}/homebrewCerts.json`;

// The name is not free: vd_appinstall answers a path it does not like with a security error that
// reads like a certificate problem.
const REMOTE_WGT = `${STAGING_DIR}/package.wgt`;
const REMOTE_PROFILE = `${STAGING_DIR}/device-profile.xml`;

const CHUNK = 4000;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const NOTHING = () => {};

const frame = (tag, value) => {
    const buffer = Buffer.alloc(8);
    buffer.write(tag, 0, 4, 'ascii');
    buffer.writeUInt32LE(value, 4);
    return buffer;
};

// An unsigned .wgt installs over the LAN because the set re-signs it, but over sdb nothing does and
// the set answers "Check certificate error".
const isSigned = async (buffer) => {
    try {
        const names = Object.keys((await JSZip.loadAsync(buffer)).files);
        return names.indexOf('author-signature.xml') !== -1 && names.indexOf('signature1.xml') !== -1;
    } catch (e) {
        return false;
    }
};

// Both ids come out of config.xml, which is inside the package the caller already holds.
const idsIn = (manifest) => {
    const packageId = /<tizen:application\b[^>]*\bpackage="([^"]+)"/.exec(manifest);
    const appId = /<tizen:application\b[^>]*\bid="([^"]+)"/.exec(manifest);

    if (!packageId || !appId) throw friendly('That package has no readable <tizen:application> ids.');

    return { packageId: packageId[1], appId: appId[1] };
};

const manifestIn = async (buffer) => {
    const zip = await JSZip.loadAsync(buffer).catch(() => null);
    const file = zip && zip.files['config.xml'];

    if (!file) throw friendly('That package holds no config.xml, so it is not a Tizen widget.');

    return file.async('string');
};

const whenOpen = (stream) => new Promise((resolve, reject) => {
    if (stream.remoteId() !== -1) return resolve();

    const timer = setTimeout(() => reject(friendly('The TV never acknowledged the sync channel.')), 10000);

    stream.once('open', () => {
        clearTimeout(timer);
        resolve();
    });
});

const push = (session, remotePath, data, onProgress) => {
    const stream = session._client.createStream('sync:');

    return whenOpen(stream).then(() => new Promise((resolve, reject) => {
        let reply = Buffer.alloc(0);
        let settled = false;

        const timer = setTimeout(() => finish(friendly('Timed out waiting for the TV to accept the file.')), 120000);

        function finish(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener('data', onData);
            if (err) reject(err); else resolve();
        }

        function onData(chunk) {
            reply = Buffer.concat([reply, chunk]);
            if (reply.length < 8) return;

            const tag = reply.slice(0, 4).toString('ascii');
            if (tag === 'OKAY') return finish(null);
            if (tag === 'FAIL') {
                const length = reply.readUInt32LE(4);
                return finish(friendly(`The TV rejected the file: ${reply.slice(8, 8 + length).toString()}`));
            }
            finish(friendly(`Unexpected sync reply: ${tag}`));
        }

        stream.on('data', onData);
        stream.on('error', (e) => finish(friendly(`Sync stream error: ${e.message}`)));

        const target = `${remotePath},33261`;
        stream.write(frame('SEND', Buffer.byteLength(target)));
        stream.write(Buffer.from(target));

        for (let offset = 0; offset < data.length; offset += CHUNK) {
            const slice = data.slice(offset, offset + CHUNK);
            stream.write(frame('DATA', slice.length));
            stream.write(slice);
            if (onProgress) onProgress(Math.min(offset + CHUNK, data.length), data.length);
        }

        stream.write(frame('DONE', Math.floor(Date.now() / 1000)));
    }));
};

const launchApp = async (ip, id) => {
    try {
        const response = await fetch(`http://${ip}:8001/api/v2/applications/${id}`, {
            method: 'POST',
            signal: AbortSignal.timeout(6000)
        });

        return response.ok;
    } catch (e) {
        return false;
    }
};

// The only trustworthy confirmation available: shell commands on this firmware return no output to
// judge by.
const confirmInstalled = async (ip, id, attempt) => {
    const attempts = attempt || 1;

    try {
        const response = await fetch(`http://${ip}:8001/api/v2/applications/${id}`, {
            signal: AbortSignal.timeout(5000)
        });

        if (response.ok) {
            const body = await response.json();
            if (body && body.id === id) return body;
        }
    } catch (e) {
        // Fall through to the retry; the registry lags the install slightly.
    }

    if (attempts >= 10) return null;

    await new Promise((resolve) => setTimeout(resolve, 1000));

    return confirmInstalled(ip, id, attempts + 1);
};

// sdbd accepts the socket from any address then drops it if the developer host IP does not match,
// so that one failure is worth naming rather than reporting as a reset.
const connect = (ip, mine) => sdb.connect({ host: ip }).catch((error) => {
    if (['sdbReset', 'sdbClosed', 'sdbTimeout'].indexOf(error.code) === -1) throw error;

    throw friendly(
        'The TV accepted the connection then dropped it, which means its\n' +
        '  developer host IP is not this machine.\n\n' +
        '  On the TV: Apps > 12345 (or hold Enter) > Settings, then set\n' +
        `    Host PC IP  =  ${mine || '<this machine\'s IP>'}\n\n` +
        '  Restart the TV and run this again — that value is only read\n' +
        '  at startup, so a change without a restart does nothing.'
    );
});

// The one sequence: remove what is there if asked, stage the distributor profile, send the package,
// install it, and confirm against the TV's own registry.
const install = async (session, options) => {
    const on = options.on || {};
    const { ip, wgt, packageId, appId, profile } = options;

    if (options.replace) {
        const removing = Date.now();

        // Nothing is checked afterwards: an app that was not installed reports failure, which is the
        // outcome asked for.
        await session.exec(`shell:0 vd_appuninstall ${packageId}`, {
            timeout: 120000,
            until: (out) => out.indexOf('spend time') !== -1 || out.indexOf('uninstall failed') !== -1
        }).catch(() => null);

        (on.removed || NOTHING)(Date.now() - removing);
    }

    // The distributor profile `mint` writes beside the certificates. Without it on the TV a correctly
    // signed package is refused with a security error that names neither.
    if (profile) {
        await push(session, REMOTE_PROFILE, profile);
        (on.profile || NOTHING)(true);
    } else {
        (on.profile || NOTHING)(false);
    }

    const started = Date.now();

    await push(session, REMOTE_WGT, wgt, on.progress || NOTHING);

    const output = await session.exec(`shell:0 vd_appinstall ${packageId} ${REMOTE_WGT}`, {
        timeout: 180000,
        until: verdicts.settled
    });

    // One reading of what the television said, shared with the service. `failureIn` rather than
    // `interpret`: no output at all is not a failure here.
    const failure = verdicts.failureIn(output, { packageId, replaceWith: options.replaceWith });

    if (failure) {
        const advice = failure.remedy ? `\n\n  ${failure.remedy.split('\n').join('\n  ')}` : '';
        throw friendly(`The TV refused the package.\n\n  ${failure.line}${advice}`);
    }

    // Absence of an error is not proof: this firmware returns no output for shell commands.
    const installed = await confirmInstalled(ip, appId);

    if (!installed) {
        throw friendly(
            'Tizen Homebrew did not appear in the TV\'s application list after installing.\n\n' +
            `  ${output.trim() ? output.trim().slice(-300) : 'The installer produced no output.'}`
        );
    }

    return { version: installed.version, took: Date.now() - started };
};

// Left where the service adopts them on first start, so nobody has to read a PIN off the television
// and run `npm run certs`.
const handOff = (session, pair) => push(session, HANDOFF_PATH, Buffer.from(JSON.stringify(pair)));

module.exports = {
    connect, install, handOff, push, isSigned, idsIn, manifestIn, launchApp, confirmInstalled,
    STAGING_DIR, HANDOFF_PATH, REMOTE_WGT
};
