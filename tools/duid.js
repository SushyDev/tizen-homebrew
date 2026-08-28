'use strict';

// The TV's DUID, which is the one thing you cannot mint a certificate without.
//
//   npm run duid -- 192.168.2.9
//
// Samsung binds a certificate to a specific television, and `create-samsung-cert
// --duidList` is where that identity goes. Getting it normally means Tizen
// Studio's sdb, which is a gigabyte of download for one string, so this asks
// the TV directly over the same vendored ADB client the service uses.
//
// Two places claim to know it, and they are not equally trustworthy:
//
//   · `shell:0 getduid` over sdb is what the reference implementation feeds to
//     the certificate creator, so it is the answer.
//   · the device API on port 8001 reports a `duid` field to anyone who asks,
//     with no developer mode and no sdb involved.
//
// They may well be the same string on every model. They are not *known* to be,
// and a certificate minted against the wrong identity fails at install with
// "Check certificate error" — a message that says nothing about why. So this
// prints the one it can prove, says where it came from, and when it has both
// it says whether they agreed.

const { networkInterfaces } = require('os');

const ui = require('./ui.js');
const sdb = require('../service/src/tv/sdb.js');

const DEVICE_API_PORT = 8001;

function friendly(message) {
    return Object.assign(new Error(message), { isFriendly: true });
}

// The address on this machine that the TV would have to be pointed at, for the
// message that has to tell somebody what to type into a television.
function localAddressFor(tvIp) {
    const prefix = tvIp.split('.').slice(0, 3).join('.');
    const interfaces = networkInterfaces();
    let fallback = null;

    for (const name in interfaces) {
        for (const entry of interfaces[name] || []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (entry.address.indexOf(`${prefix}.`) === 0) return entry.address;
            if (!fallback) fallback = entry.address;
        }
    }

    return fallback;
}

/** What the TV says about itself on port 8001. Never throws; absence is an answer. */
async function describe(ip) {
    try {
        const response = await fetch(`http://${ip}:${DEVICE_API_PORT}/api/v2/`, {
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) return null;

        const { device } = await response.json();
        return device || null;
    } catch (e) {
        return null;
    }
}

/** The DUID as sdbd itself reports it, or null when sdbd will not have us. */
async function ask(ip) {
    const session = await sdb.connect({ host: ip, timeout: 6000 });

    try {
        return await session.getDuid();
    } finally {
        session.close();
    }
}

async function main() {
    const ip = process.argv.slice(2).filter((argument) => argument[0] !== '-')[0];

    if (!ip) {
        throw friendly(
            'Which TV?\n\n  npm run duid -- <tv-ip>\n\n' +
            '  Find it in the TV\'s network settings, or check your router.'
        );
    }

    ui.heading('duid', ip);
    ui.blank();

    const device = await describe(ip);

    if (device) {
        ui.info('model', device.modelName || device.model || 'unknown');
        ui.info('dev mode', device.developerMode === '1' ? 'on' : 'OFF');
    } else {
        ui.warn(`nothing answered on ${ip}:${DEVICE_API_PORT} — is that the right address, and is the TV on?`);
    }

    ui.blank();

    const reported = device && device.duid ? String(device.duid) : null;

    const measured = await ask(ip).catch((error) => {
        // sdbd accepts the socket from any address and only then drops it if
        // the developer host IP is not ours. Once a TV has been pinned to
        // 127.0.0.1 — which is the whole point of this project — that is the
        // expected outcome from a laptop, not a fault.
        if (['sdbRefused', 'sdbReset', 'sdbClosed', 'sdbTimeout'].indexOf(error.code) !== -1) return null;
        throw error;
    });

    if (measured) {
        ui.ok('duid', measured);
        ui.note(ui.style.dim('  from `getduid` over sdb — the value create-samsung-cert wants'));

        if (reported) {
            const agrees = reported === measured || reported.replace(/^uuid:/, '') === measured;
            ui.note(ui.style.dim(agrees
                ? `  the device API agrees (${reported})`
                : `  the device API says something else: ${reported}`));
        }

        ui.blank();
        ui.note('Mint a certificate pair bound to it:');
        ui.blank();
        ui.note(ui.style.dim('  npx tizenjs create-samsung-cert --privilege Public \\'));
        ui.note(ui.style.dim('    --name <you> --email <you@example.com> --password <password> \\'));
        ui.note(ui.style.dim(`    --duidList ${measured} --output ~/.tizen-certs`));
        ui.blank();
        return;
    }

    // No sdb. Say what the other source claims, and be plain that it is a lead
    // rather than an answer.
    const mine = localAddressFor(ip);

    if (reported) {
        ui.warn('sdb would not answer, so this is unverified');
        ui.info('duid?', reported);
        ui.note(ui.style.dim(`  the device API reports this; \`getduid\` is what mints a working certificate`));
    } else {
        throw friendly(
            `Could not reach sdb on ${ip}, and the device API did not report a duid either.\n\n` +
            '  Turn Developer Mode on: Apps > 12345 (or hold Enter) > Settings.'
        );
    }

    ui.blank();
    ui.note('To confirm it, sdbd has to accept this machine. Either:');
    ui.blank();
    ui.note(ui.style.dim(`  · point the TV's Host PC IP at ${mine || 'this machine'} and restart it, then run this again`));
    ui.note(ui.style.dim('  · or run `getduid` through Tizen Homebrew\'s own relay, from the phone UI\'s'));
    ui.note(ui.style.dim('    Shell tab, which reaches sdbd over loopback and needs no repointing'));
    ui.blank();
}

main().catch((err) => ui.crash(err));
