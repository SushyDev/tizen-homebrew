'use strict';

// Installs Tizen Homebrew onto the TV from this machine, over the vendored ADB client. `--replace`
// removes what is installed first, which is the only way past a changed author certificate.
//
// The install itself lives in installing.js, because the standalone installer does the same thing
// to a package it downloaded rather than one built here.

const { readFileSync, existsSync, statSync } = require('fs');
const { join, dirname } = require('path');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const { localAddressFor } = require('./tv.js');
const installing = require('./installing.js');

const WGT = 'release/homebrew.wgt';

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

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

    const file = join(ROOT, WGT);

    if (!existsSync(file)) {
        throw friendly(`No package at ${WGT}\n\n  Build one first:  npm run package -- --sign`);
    }

    const wgt = readFileSync(file);

    if (!await installing.isSigned(wgt)) {
        throw friendly(
            `${WGT} is not signed, and sdb will not install an unsigned package.\n\n` +
            '  `npm run package` builds those; they are for `npm run push`, which goes\n' +
            '  through Tizen Homebrew and re-signs on the way in.\n\n' +
            '  Build a signed one:  npm run package -- --sign'
        );
    }

    const { packageId, appId } = installing.idsIn(await installing.manifestIn(wgt));

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

    const session = await installing.connect(ip, localAddressFor(ip));

    const profilePath = join(dirname(certificates.locate().author), 'device-profile.xml');
    const profile = existsSync(profilePath) ? readFileSync(profilePath) : null;

    if (!profile) ui.warn('no device-profile.xml beside the certificates — the TV may refuse the package');

    try {
        let lastShown = 0;

        const installed = await installing.install(session, {
            ip,
            wgt,
            profile,
            packageId,
            appId,
            replace,
            replaceWith: `npm run bootstrap -- ${ip} --replace`,
            on: {
                removed: (took) => ui.ok('removed', 'the previously installed copy', took),
                profile: (staged) => {
                    if (staged) ui.ok('profile', 'device-profile.xml staged for this certificate');
                },
                progress: (sent, total) => {
                    const percent = Math.floor((sent / total) * 100);
                    if (percent < lastShown + 25 && sent !== total) return;
                    lastShown = percent;
                    process.stdout.write(`  ${ui.style.dim(`uploading ${percent}%`)}\r`);
                }
            }
        });

        process.stdout.write('                                        \r');

        ui.ok('homebrew', `${ui.bytes(statSync(file).size)} · v${installed.version || '?'}`, installed.took);

        const handed = handOffCertificates();

        if (handed) {
            await installing.handOff(session, handed);
            ui.ok('certificates', `sent for ${handed.devices.join(', ') || 'an unnamed device'}`);
        } else {
            ui.warn('no certificate pair here to send — `npm run certs` after this, or `npm run mint` first');
        }
    } finally {
        session.close();
    }

    // Open it, so its screen is up with the URL and PIN already showing.
    const launched = await installing.launchApp(ip, appId);
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
