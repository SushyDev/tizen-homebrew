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

const ui = require('./ui.js');
const certificates = require('./certificates.js');
const { duidOf, describe, localAddressFor, DEVICE_API_PORT } = require('./tv.js');

function friendly(message) {
    return Object.assign(new Error(message), { isFriendly: true });
}

/**
 * Every device a distributor certificate was minted for.
 *
 * Offline, and true whether or not the TV is reachable — but it describes the
 * certificate, not whatever is at the other end of the network, which is the
 * whole reason it is reported separately.
 *
 * A list, because `--duidList` is one: reporting only the first name made a
 * pair that covers this television read as one minted for somebody else's.
 */
function boundDevices() {
    const { distributor: path, distributorPassword: password } = certificates.locate();
    const devices = certificates.devicesIn(path, password);

    return devices.length ? { devices, path } : null;
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

    const measured = await duidOf(ip, pin);

    const bound = boundDevices();

    if (measured) {
        ui.ok('duid', measured);
        ui.note(ui.style.dim(pin
            ? '  from `getduid`, relayed through Tizen Homebrew — the value a certificate binds to'
            : '  from `getduid` over sdb — the value a certificate binds to'));

        if (bound && bound.devices.indexOf(measured) !== -1) {
            ui.note(ui.style.dim(`  the certificate in ${bound.path} covers this TV`));
            ui.blank();
            return;
        }

        if (bound) {
            ui.blank();
            ui.warn(`the certificate in ${bound.path} names ${bound.devices.join(', ')} — none of which is this television`);
            ui.note(ui.style.dim('  packages signed with it upload fine and are then refused with'));
            ui.note(ui.style.dim('  "Check certificate error", which names neither the certificate nor the device'));
        }

        ui.blank();
        ui.note('Mint a pair bound to it:');
        ui.note(ui.style.dim(`  npm run mint -- ${ip}${pin ? ` ${pin}` : ''}`));
        ui.blank();
        return;
    }

    // No sdb. Say what the other source claims, and be plain that it is a lead
    // rather than an answer.
    const mine = localAddressFor(ip);

    ui.warn('sdb would not answer, so this TV was not asked');

    if (bound) {
        ui.info('duid', bound.devices.join(', '));
        ui.note(ui.style.dim(`  not from the TV — ${bound.devices.length > 1 ? 'these are the devices' : 'this is the device'} ${bound.path} names,`));
        ui.note(ui.style.dim('  and this television may or may not be among them'));
    } else if (device) {
        ui.note(ui.style.dim(`  and no certificate to read one out of either`));
    }

    if (reported) {
        ui.blank();
        ui.note(ui.style.dim(`  (the device API's "duid" field says ${reported}, which is a different`));
        ui.note(ui.style.dim('   identifier entirely and is not what a certificate is bound to)'));
    }

    ui.blank();

    // The relay is the answer on a set pinned to loopback, and it is one
    // argument away — so when no PIN was given, that is the first thing to
    // say, not the third. Without it this command can only read a certificate
    // back to somebody who is asking precisely because they doubt it.
    if (!pin) {
        ui.note('To ask the television itself, give it the PIN from the TV screen:');
        ui.blank();
        ui.note(ui.style.dim(`  npm run duid -- ${ip} <pin>`));
        ui.blank();
        ui.note(ui.style.dim('  That relays `getduid` through Tizen Homebrew, which reaches sdbd over'));
        ui.note(ui.style.dim('  loopback — no repointing, and as authoritative as asking sdb directly.'));
        ui.blank();
        return;
    }

    ui.note('To ask the television itself, sdbd has to accept this machine. Either:');
    ui.blank();
    ui.note(ui.style.dim(`  · point the TV's Host PC IP at ${mine || 'this machine'} and restart it, then run this again`));
    ui.note(ui.style.dim('  · or run `getduid` through Tizen Homebrew\'s own relay, from the phone UI\'s'));
    ui.note(ui.style.dim('    Shell tab, which reaches sdbd over loopback and needs no repointing'));
    ui.blank();
}

main().catch((err) => ui.crash(err));
