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
// The device API on port 8001 also has a field called `duid`, and it is a trap.
// On the television this was written against it reports
// `uuid:21f31367-a5a6-4d3d-8078-8dd4d090a334` while the certificate minted for
// that same set is bound to `CPCLIM2YRW7DO`. Two different identifiers, one
// misleading name; a certificate minted against the wrong one fails at install
// with "Check certificate error", which says nothing about why. So that field
// is not offered here as an answer, or as a guess.
//
// When sdb will not answer — which is the normal state once a TV is pinned to
// 127.0.0.1 — there is still one honest source left. A Samsung distributor
// certificate carries the device it was minted for in its subjectAltName:
//
//   URI:URN:tizen:deviceid=CPCLIM2YRW7DO
//
// So the certificate you already have will tell you which television it
// belongs to, which answers the question that usually prompts this: whether
// the pair on this machine is the pair for the TV in front of you.

const { networkInterfaces } = require('os');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

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

/**
 * The device a distributor certificate was minted for.
 *
 * Offline, and true whether or not the TV is reachable — but it describes the
 * certificate, not whatever is at the other end of the network, which is the
 * whole reason it is reported separately.
 */
function boundDevice() {
    const p12Path = process.env.TIZEN_DISTRIBUTOR_P12 ||
        join(process.env.HOME || '', '.tizen-certs', 'distributor.p12');

    const password = process.env.TIZEN_DISTRIBUTOR_PW || process.env.TIZEN_AUTHOR_PW;

    if (!password || !existsSync(p12Path)) return null;

    try {
        const forge = require('node-forge');

        const p12 = forge.pkcs12.pkcs12FromAsn1(
            forge.asn1.fromDer(readFileSync(p12Path).toString('binary')),
            password
        );

        const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];

        for (const bag of bags) {
            const alt = bag.cert && bag.cert.getExtension('subjectAltName');

            for (const name of (alt && alt.altNames) || []) {
                const match = /deviceid=(.+)$/.exec(name.value || '');
                if (match) return { device: match[1], path: p12Path };
            }
        }
    } catch (e) {
        // A wrong password or an unreadable file is not worth failing over:
        // this is the consolation prize, not the answer.
    }

    return null;
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

    const bound = boundDevice();

    if (measured) {
        ui.ok('duid', measured);
        ui.note(ui.style.dim('  from `getduid` over sdb — the value create-samsung-cert wants'));

        if (bound) {
            ui.note(ui.style.dim(bound.device === measured
                ? `  the certificate in ${bound.path} is bound to this TV`
                : `  the certificate in ${bound.path} is bound to ${bound.device}, which is NOT this TV`));
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

    ui.warn('sdb would not answer, so this TV was not asked');

    if (bound) {
        ui.info('duid', bound.device);
        ui.note(ui.style.dim(`  not from the TV — this is the device ${bound.path} was minted for`));
    } else if (device) {
        ui.note(ui.style.dim(`  and no certificate to read one out of either`));
    }

    if (reported) {
        ui.blank();
        ui.note(ui.style.dim(`  (the device API's "duid" field says ${reported}, which is a different`));
        ui.note(ui.style.dim('   identifier entirely and is not what a certificate is bound to)'));
    }

    ui.blank();
    ui.note('To ask the television itself, sdbd has to accept this machine. Either:');
    ui.blank();
    ui.note(ui.style.dim(`  · point the TV's Host PC IP at ${mine || 'this machine'} and restart it, then run this again`));
    ui.note(ui.style.dim('  · or run `getduid` through Tizen Homebrew\'s own relay, from the phone UI\'s'));
    ui.note(ui.style.dim('    Shell tab, which reaches sdbd over loopback and needs no repointing'));
    ui.blank();
}

main().catch((err) => ui.crash(err));
