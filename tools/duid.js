'use strict';

const ui = require('./ui.js');
const certificates = require('./certificates.js');
const { duidOf, describe, localAddressFor, DEVICE_API_PORT } = require('./tv.js');

function friendly(message) {
    return Object.assign(new Error(message), { isFriendly: true });
}

// A distributor certificate carries the device it was minted for, which describes the certificate
// rather than the television — and `--duidList` is a list, so reporting only the first name made a
// pair that covers this set read as one minted for somebody else's.
function boundDevices() {
    const { distributor: path, distributorPassword: password } = certificates.locate();
    const devices = certificates.devicesIn(path, password);

    return devices.length ? { devices, path } : null;
}

// The device API on port 8001 also serves a field called `duid`, and it is a different identifier
// entirely: a certificate minted against it fails at install with "Check certificate error".
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
