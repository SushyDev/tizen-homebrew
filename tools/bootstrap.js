'use strict';

// Installs Tizen Homebrew onto the TV from this machine, over the vendored ADB client. `--replace`
// removes what is installed first, which is the only way past a changed author certificate.

const { readFileSync, existsSync, statSync } = require('fs');
const { join, dirname } = require('path');

const JSZip = require('jszip');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const { localAddressFor } = require('./tv.js');
const sdb = require('../service/src/tv/sdb.js');
const verdicts = require('../service/src/install/verdicts.js');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';

// Must match service/src/config.js. In the staging directory because sdb refuses the rest of share/.
const HANDOFF_PATH = `${STAGING_DIR}/homebrewCerts.json`;

const WGT = 'release/tizenhomebrew.wgt';
const MANIFEST = 'config.xml';

function packageId(manifest) {
    const match = readFileSync(join(ROOT, manifest), 'utf8')
        .match(/<tizen:application\b[^>]*\bpackage="([^"]+)"/);
    if (!match) throw friendly(`Could not read the package id from ${manifest}.`);
    return match[1];
}

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

async function isSigned(path) {
    try {
        const zip = await JSZip.loadAsync(readFileSync(path));
        const names = Object.keys(zip.files);

        return names.indexOf('author-signature.xml') !== -1 && names.indexOf('signature1.xml') !== -1;
    } catch (e) {
        return false;
    }
}

function handOffCertificates() {
    const found = certificates.locate();

    if (certificates.missing(found).length) return null;

    try {
        return {
            author: certificates.asPem(readFileSync(found.author), found.password),
            distributor: certificates.asPem(readFileSync(found.distributor), found.distributorPassword),
            devices: certificates.devicesIn(found.distributor, found.distributorPassword)
        };
    } catch (e) {
        return null;
    }
}

const whenOpen = (stream) => new Promise((resolve, reject) => {
    if (stream.remoteId() !== -1) return resolve();

    const timer = setTimeout(() => reject(friendly('The TV never acknowledged the sync channel.')), 10000);

    stream.once('open', () => {
        clearTimeout(timer);
        resolve();
    });
});

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

function appId(manifest) {
    const match = readFileSync(join(ROOT, manifest), 'utf8')
        .match(/<tizen:application\b[^>]*\bid="([^"]+)"/);
    if (!match) throw friendly(`Could not read the application id from ${manifest}.`);
    return match[1];
}

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

// The only trustworthy confirmation available: shell commands on this firmware return no output to judge by.
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

    // An unsigned .wgt installs over the LAN because the set re-signs it, but over sdb nothing does and the
    // set answers "Check certificate error".
    if (!await isSigned(join(ROOT, WGT))) {
        throw friendly(
            `${WGT} is not signed, and sdb will not install an unsigned package.\n\n` +
            '  `npm run package -- --unsigned` builds those; they are for `npm run push`,\n' +
            '  which goes through Tizen Homebrew and re-signs on the way in.\n\n' +
            '  Build a signed one:  npm run package'
        );
    }

    ui.heading('bootstrap', ip);

    const device = await probe(ip);
    ui.info('model', `${device.modelName || device.model || 'unknown'}`);
    ui.info('dev mode', device.developerMode === '1' ? 'on' : 'OFF');
    // The API's developerIP is not reported: it has claimed 127.0.0.1 during a successful install from this
    // machine.
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
        // sdbd accepts the socket from any address then drops it if the developer host IP does not match.
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

            // Nothing is checked afterwards: an app that was not installed reports failure, which is the
            // outcome asked for.
            await session.exec(`shell:0 vd_appuninstall ${packageId(MANIFEST)}`, {
                timeout: 120000,
                until: (out) => out.indexOf('spend time') !== -1 || out.indexOf('uninstall failed') !== -1
            }).catch(() => null);

            ui.ok('removed', 'the previously installed copy', Date.now() - removing);
        }

        // The distributor profile `mint` writes beside the certificates. Without it on the TV a correctly
        // signed package is refused with a security error that names neither.
        const profile = join(dirname(certificates.locate().author), 'device-profile.xml');

        if (existsSync(profile)) {
            await push(session, `${STAGING_DIR}/device-profile.xml`, readFileSync(profile));
            ui.ok('profile', 'device-profile.xml staged for this certificate');
        } else {
            ui.warn(`no device-profile.xml beside the certificates — the TV may refuse the package`);
        }

        const file = join(ROOT, WGT);
        const buffer = readFileSync(file);
        // The name is not free: vd_appinstall answers a path it does not like with a security error that reads
        // like a certificate problem.
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
            until: verdicts.settled
        });

        // One reading of what the television said, shared with the service. `failureIn` rather than
        // `interpret`: no output at all is not a failure here.
        const failure = verdicts.failureIn(output, {
            packageId: packageId(MANIFEST),
            replaceWith: `npm run bootstrap -- ${ip} --replace`
        });

        if (failure) {
            const advice = failure.remedy
                ? `\n\n  ${failure.remedy.split('\n').join('\n  ')}`
                : '';

            throw friendly(`The TV refused the package.\n\n  ${failure.line}${advice}`);
        }

        // Absence of an error is not proof: this firmware returns no output for shell commands, so confirm
        // against the TV's own registry.
        const installed = await confirmInstalled(ip, appId(MANIFEST));
        if (!installed) {
            throw friendly(
                'Tizen Homebrew did not appear in the TV\'s application list after installing.\n\n' +
                `  ${output.trim() ? output.trim().slice(-300) : 'The installer produced no output.'}`
            );
        }

        ui.ok('homebrew', `${ui.bytes(statSync(file).size)} · v${installed.version || '?'}`, Date.now() - started);

        // Left where the service adopts them on first start, so nobody has to read a PIN off the television
        // and run `npm run certs`.
        const handed = handOffCertificates();

        if (handed) {
            await push(session, HANDOFF_PATH, Buffer.from(JSON.stringify(handed)));
            ui.ok('certificates', `sent for ${handed.devices.join(', ') || 'an unnamed device'}`);
        } else {
            ui.warn('no certificate pair here to send — `npm run certs` after this, or `npm run mint` first');
        }

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
