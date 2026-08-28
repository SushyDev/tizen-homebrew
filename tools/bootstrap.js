'use strict';

// One-time bootstrap: installs Tizen Homebrew onto the TV from this machine.
//
//   npm run bootstrap -- 192.168.2.9
//   npm run bootstrap -- 192.168.2.9 --replace
//
// Installs Tizen Homebrew and nothing else. Every other app is meant to come
// from Tizen Homebrew itself, on the phone.
//
// `--replace` removes what is already installed before installing. Tizen
// refuses to update an app whose *author* certificate has changed —
// "install failed[118, -11], reason: Author certificate not match" — and a
// certificate changes every time a pair is re-minted. Removing the app first
// is the only way through that, and it cannot be done from the television's
// own relay: taking Tizen Homebrew off a set that is pinned to 127.0.0.1
// leaves nothing that can reach sdbd, which is why relay.js refuses it. Here
// it is safe, because getting this far means sdbd is already answering this
// machine.
//
// This is the only step that ever needs a computer. It exists because the TV
// cannot install its first app by itself, and because Tizen Studio's `sdb` is
// a ~1GB download for one command. Everything here speaks the ADB protocol
// directly, over the vendored ADB client the service already uses.
//
// After this runs once, set the TV's developer host IP to 127.0.0.1 and this
// script is never needed again — Tizen Homebrew handles every later install
// from your phone.

const { readFileSync, existsSync, statSync } = require('fs');
const { join, dirname } = require('path');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const { localAddressFor } = require('./tv.js');
const sdb = require('../service/src/tv/sdb.js');

// Where packages are staged on the TV before vd_appinstall reads them. This is
// the directory the Tizen installer expects to find sideloaded packages in.
const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';

const WGT = 'release/tizenhomebrew.wgt';
const MANIFEST = 'config.xml';

// Read from the manifest rather than hardcoded, so renaming a package can
// never leave this installing under the wrong id.
function packageId(manifest) {
    const match = readFileSync(join(ROOT, manifest), 'utf8')
        .match(/<tizen:application\b[^>]*\bpackage="([^"]+)"/);
    if (!match) throw friendly(`Could not read the package id from ${manifest}.`);
    return match[1];
}

// The connection advertises maxdata=4096 in its handshake, and each sync frame
// costs an 8-byte header, so payloads have to stay comfortably under that.
const CHUNK = 4000;

function friendly(message) {
    return Object.assign(new Error(message), { isFriendly: true });
}

function frame(tag, value) {
    const buffer = Buffer.alloc(8);
    buffer.write(tag, 0, 4, 'ascii');
    buffer.writeUInt32LE(value, 4);
    return buffer;
}

// Waits for the daemon to answer OPEN, which is when the stream has a remote
// id and can be written to.
const whenOpen = (stream) => new Promise((resolve, reject) => {
    if (stream.remoteId() !== -1) return resolve();

    const timer = setTimeout(() => reject(friendly('The TV never acknowledged the sync channel.')), 10000);

    stream.once('open', () => {
        clearTimeout(timer);
        resolve();
    });
});

// Pushes a buffer to `remotePath` using the ADB sync protocol.
function push(session, remotePath, data, onProgress) {
    const client = session._client;
    const stream = client.createStream('sync:');

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

        // SEND <path>,<mode>   — 33261 is 0100755, what the installer expects.
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
}

// The application id, as opposed to the package id vd_appinstall wants.
function appId(manifest) {
    const match = readFileSync(join(ROOT, manifest), 'utf8')
        .match(/<tizen:application\b[^>]*\bid="([^"]+)"/);
    if (!match) throw friendly(`Could not read the application id from ${manifest}.`);
    return match[1];
}

// Launches an app on the TV. POST to the applications endpoint is accepted
// even though the rest of that API is read-only, which saves hunting for the
// app in the TV's own list after installing.
async function launchApp(ip, id) {
    try {
        const res = await fetch(`http://${ip}:8001/api/v2/applications/${id}`, {
            method: 'POST',
            signal: AbortSignal.timeout(6000)
        });
        return res.ok;
    } catch (e) {
        return false;
    }
}

// Asks the TV whether an app is actually registered. This is the only
// trustworthy confirmation available, because shell commands on this firmware
// return no output to judge by.
async function confirmInstalled(ip, id, attempt) {
    const attempts = attempt || 1;
    try {
        const res = await fetch(`http://${ip}:8001/api/v2/applications/${id}`, {
            signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
            const body = await res.json();
            if (body && body.id === id) return body;
        }
    } catch (e) {
        // Fall through to the retry; the registry lags the install slightly.
    }

    if (attempts >= 10) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return confirmInstalled(ip, id, attempts + 1);
}

function probe(ip) {
    return fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(5000) })
        .then((res) => res.json())
        .then((json) => json.device)
        .catch((err) => {
            throw friendly(`Could not reach the TV at ${ip}:8001 — ${err.message}\n  Is it on, and on this network?`);
        });
}

async function main() {
    const replace = process.argv.indexOf('--replace') !== -1;
    const ip = process.argv.slice(2).filter((argument) => argument[0] !== '-')[0];
    if (!ip) {
        throw friendly('Which TV?\n\n  npm run bootstrap -- <tv-ip>\n\n  Find it in the TV\'s network settings, or check your router.');
    }

    if (!existsSync(join(ROOT, WGT))) {
        throw friendly(`No package at ${WGT}\n\n  Build one first:  npm run package`);
    }

    ui.heading('bootstrap', ip);

    const device = await probe(ip);
    ui.info('model', `${device.modelName || device.model || 'unknown'}`);
    ui.info('dev mode', device.developerMode === '1' ? 'on' : 'OFF');
    // The API's developerIP is not reported: it has been seen claiming
    // 127.0.0.1 during a successful install from this machine. Whether sdb
    // accepts us is established below, by connecting.
    ui.blank();

    if (device.developerMode !== '1') {
        throw friendly(
            'Developer Mode is off on this TV.\n\n' +
            '  On the TV: open Apps, press 12345 (or hold Enter), choose Settings,\n' +
            '  turn Developer mode on, then set\n' +
            `    Host PC IP  =  ${localAddressFor(ip) || '<this machine\'s IP>'}`
        );
    }

    const session = await sdb.connect({ host: ip }).catch((err) => {
        // sdbd accepts the socket from any address, then drops it if the
        // developer host IP does not match. Depending on timing that surfaces
        // as a reset, a close before the handshake, or a timeout — all of them
        // mean the same thing here.
        if (['sdbReset', 'sdbClosed', 'sdbTimeout'].indexOf(err.code) !== -1) {
            const mine = localAddressFor(ip);
            throw friendly(
                'The TV accepted the connection then dropped it, which means its\n' +
                '  developer host IP is not this machine.\n\n' +
                '  On the TV: Apps > 12345 (or hold Enter) > Settings, then set\n' +
                `    Host PC IP  =  ${mine || '<this machine\'s IP>'}\n\n` +
                '  Restart the TV and run this again — that value is only read\n' +
                '  at startup, so a change without a restart does nothing.'
            );
        }
        throw err;
    });

    try {
        if (replace) {
            const removing = Date.now();

            // Nothing is checked afterwards: an app that was not installed
            // reports failure here and that is the outcome asked for.
            await session.exec(`shell:0 vd_appuninstall ${packageId(MANIFEST)}`, {
                timeout: 120000,
                until: (out) => out.indexOf('spend time') !== -1 || out.indexOf('uninstall failed') !== -1
            }).catch(() => null);

            ui.ok('removed', 'the previously installed copy', Date.now() - removing);
        }

        // The distributor profile, which the television validates the package's
        // distributor certificate against. `mint` writes it beside the
        // certificates; without it on the TV, a correctly signed package is
        // refused with
        //
        //   install failed[118, -22], reason: Security error :
        //     :Invalid function parameter was given:<2>
        //
        // naming neither the profile nor the certificate. It is easy to miss
        // because a television that has ever been set up by another tool
        // already has one, and everything works until the certificate changes.
        const profile = join(dirname(certificates.locate().author), 'device-profile.xml');

        if (existsSync(profile)) {
            await push(session, `${STAGING_DIR}/device-profile.xml`, readFileSync(profile));
            ui.ok('profile', 'device-profile.xml staged for this certificate');
        } else {
            ui.warn(`no device-profile.xml beside the certificates — the TV may refuse the package`);
        }

        const file = join(ROOT, WGT);
        const buffer = readFileSync(file);
        // `package.wgt`, and the name is not free. vd_appinstall answers a path
        // it does not like with
        //
        //   install failed[118, -22], reason: Security error :
        //     :Invalid function parameter was given:<2>
        //
        // where <2> is that second argument — a message that reads like a
        // problem with the certificate and is a problem with the filename.
        // service/src/install/installer.js stages to the same name, and so
        // does every other tool that installs this way.
        const remote = `${STAGING_DIR}/package.wgt`;
        const started = Date.now();

        let lastShown = 0;
        await push(session, remote, buffer, (sent, total) => {
            const percent = Math.floor((sent / total) * 100);
            if (percent >= lastShown + 25 || sent === total) {
                lastShown = percent;
                process.stdout.write(`  ${ui.style.dim(`uploading ${percent}%`)}\r`);
            }
        });
        process.stdout.write('                                        \r');

        const output = await session.exec(`shell:0 vd_appinstall ${packageId(MANIFEST)} ${remote}`, {
            timeout: 180000,
            until: (out) => out.indexOf('spend time') !== -1 || out.indexOf('install failed') !== -1
        });

        const failure = output.split('\n').filter((line) => line.indexOf('install failed') !== -1)[0];

        if (failure && /Author certificate not match/i.test(failure)) {
            throw friendly(
                `The TV refused the package.\n\n  ${failure.trim()}\n\n` +
                '  The copy already installed was signed by a different author certificate,\n' +
                '  and Tizen will not update across that. Remove it and install fresh:\n\n' +
                `    npm run bootstrap -- ${ip} --replace`
            );
        }

        if (failure) throw friendly(`The TV refused the package.\n\n  ${failure.trim()}`);

        // Absence of an error is not proof of success: this firmware returns
        // no output at all for shell commands, so the check above would pass
        // on an empty string. Confirm against the TV's own application
        // registry instead.
        const installed = await confirmInstalled(ip, appId(MANIFEST));
        if (!installed) {
            throw friendly(
                'Tizen Homebrew did not appear in the TV\'s application list after installing.\n\n' +
                `  ${output.trim() ? output.trim().slice(-300) : 'The installer produced no output.'}`
            );
        }

        ui.ok('homebrew', `${ui.bytes(statSync(file).size)} · v${installed.version || '?'}`, Date.now() - started);

    } finally {
        session.close();
    }

    // Open it, so its screen is up with the URL and PIN already showing.
    const launched = await launchApp(ip, appId(MANIFEST));
    if (launched) ui.ok('launched', 'Tizen Homebrew is open on the TV');

    ui.blank();
    ui.note('Installed. One manual step, on the TV itself:');
    ui.blank();
    ui.note(ui.style.dim('  1. Apps > 12345 (or hold Enter) > Settings: set Host PC IP = 127.0.0.1.'));
    ui.note(ui.style.dim('  2. Restart the TV — sdbd only re-reads that value at startup.'));
    ui.blank();
    ui.note('After that everything installs from your phone and this script is');
    ui.note('never needed again. The setting cannot be changed from software:');
    ui.note('sdbd runs a command allowlist and the app sandbox denies spawning.');
    ui.blank();
}

main().catch((err) => ui.crash(err));
