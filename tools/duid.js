'use strict';

// The TV's DUID, which is the one thing you cannot mint a certificate without.
//
//   npm run duid -- 192.168.2.9
//   npm run duid -- 192.168.2.9 <pin>     through Tizen Homebrew, once it is on
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
// Once a TV is pinned to 127.0.0.1 — the point of this whole project — sdbd
// stops answering laptops, and the question has to go through the one process
// still allowed to reach it: Tizen Homebrew itself. Give this the PIN from the
// TV screen and it asks over the relay, which is as authoritative as asking
// sdb directly because it *is* asking sdb directly, from the other side.
//
// Failing both there is one offline source. A Samsung distributor certificate
// carries the device it was minted for in its subjectAltName:
//
//   URI:URN:tizen:deviceid=BDCPQZFMHIZII
//
// That describes the certificate rather than the television, which is a
// different question — and the difference is not academic. A pair minted for
// the wrong set produces packages that build, sign, upload and are then
// refused by the TV with "Check certificate error", which names neither the
// certificate nor the device.

const { networkInterfaces } = require('os');
const { existsSync, readFileSync } = require('fs');

const ui = require('./ui.js');
const sdb = require('../service/src/tv/sdb.js');
const certificates = require('./certificates.js');

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
    const { distributor: p12Path, distributorPassword: password } = certificates.locate();

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

/**
 * The same question, relayed through Tizen Homebrew on the television.
 *
 * The relay is off by default and this turns it on to ask, then puts it back
 * the way it found it. That is a real escalation to perform on somebody's
 * behalf, so it happens only when a PIN was given — which is a person reading
 * a code off the screen and typing it here.
 */
function relay(ip, pin) {
    const WebSocket = require('ws');

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${ip}:8091`);
        const send = (type, payload) => socket.send(JSON.stringify({ type, payload: payload || {} }));

        const finish = (error, value) => {
            try {
                socket.close();
            } catch (e) { /* already gone */ }

            if (error) reject(error); else resolve(value);
        };

        const deadline = setTimeout(() => finish(friendly(`Tizen Homebrew did not answer on ${ip}:8091.`)), 25000);

        let greeted = false;
        let wasEnabled = false;

        socket.on('message', (raw) => {
            const { type, payload } = JSON.parse(raw);

            if (type === 'hello' && !greeted) {
                greeted = true;
                return send('hello', { pin });
            }

            if (type === 'hello' && !payload.ok) {
                clearTimeout(deadline);
                return finish(friendly('That PIN was refused. It changes every time the service starts — check the TV screen.'));
            }

            // The relay state arrives unasked on pairing, which is how its
            // previous setting is known and can be restored afterwards.
            if (type === 'relayState' && !payload.enabled && !wasEnabled) return send('setRelay', { enabled: true });
            if (type === 'relayState' && payload.enabled) {
                wasEnabled = true;
                return send('relayExec', { id: 'duid', command: 'getduid' });
            }

            if (type === 'relayEnd') {
                clearTimeout(deadline);
                send('setRelay', { enabled: false });
                return setTimeout(() => finish(null, String(payload.output || '').trim() || null), 400);
            }

            if (type === 'error') {
                clearTimeout(deadline);
                return finish(friendly(`Tizen Homebrew refused: ${payload.message}`));
            }
        });

        socket.on('error', (error) => {
            clearTimeout(deadline);
            finish(friendly(`Could not reach Tizen Homebrew at ${ip}:8091 — ${error.message}\n\n` +
                '  Open Tizen Homebrew on the TV; the service only runs while it is open.'));
        });
    });
}

async function main() {
    const [ip, pin] = process.argv.slice(2).filter((argument) => argument[0] !== '-');

    if (!ip) {
        throw friendly(
            'Which TV?\n\n  npm run duid -- <tv-ip> [pin]\n\n' +
            '  Find the address in the TV\'s network settings, or check your router.\n' +
            '  The PIN is on the TV screen once Tizen Homebrew is installed, and lets\n' +
            '  this ask the television even with developer mode pinned to loopback.'
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

    // Through the channel first when there is a PIN for it: it works in the
    // state a set actually lives in, where sdb does not.
    const relayed = pin ? await relay(ip, pin) : null;

    const measured = relayed || await ask(ip).catch((error) => {
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
        ui.note(ui.style.dim(relayed
            ? '  from `getduid`, relayed through Tizen Homebrew — the value create-samsung-cert wants'
            : '  from `getduid` over sdb — the value create-samsung-cert wants'));

        if (bound && bound.device === measured) {
            ui.note(ui.style.dim(`  the certificate in ${bound.path} is bound to this TV`));
            ui.blank();
            return;
        }

        if (bound) {
            ui.blank();
            ui.warn(`the certificate in ${bound.path} is bound to ${bound.device}, which is NOT this television`);
            ui.note(ui.style.dim('  packages signed with it upload fine and are then refused with'));
            ui.note(ui.style.dim('  "Check certificate error", which names neither the certificate nor the device'));
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
