'use strict';

// Everything a new television needs, in one command.
//
//   npm run full-bootstrap -- 192.168.2.9
//
// mint, then package, then bootstrap: the three commands the README walks
// through, run in order against one address. Each is still its own tool and
// still works on its own — this only removes the part where a device id is
// carried between them by hand, which is where a model name gets pasted in
// place of a DUID and the television answers "Check certificate error",
// naming neither.
//
// The Samsung sign-in still happens in a browser, and this still waits for it.
// There is no way around that: Samsung issues signing certificates to
// signed-in accounts, and it is the one part of setting a television up that a
// script is not allowed to do for you.
//
// Two things are decided here instead of asked about:
//
//   · The sign-in is skipped when the pair on this machine already covers the
//     set. Every mint costs one, and most reruns need none.
//
//   · `--replace` is handed to bootstrap whenever the author certificate is
//     about to change — a first mint, or `--new-author`. Tizen will not update
//     across a changed author ("install failed[118, -11], reason: Author
//     certificate not match"), so the copy already on the TV has to go first.
//     When the author is being kept, it is not passed, because uninstalling
//     first would throw away a working install for nothing.
//
// There is no PIN argument, unlike `mint` and `duid`. Those can ask a
// television through Tizen Homebrew's relay once it is pinned to 127.0.0.1;
// bootstrap cannot, because it talks to sdbd directly and that is exactly what
// a pinned set stops answering. Taking a PIN here would resolve a device id and
// then fail at the install, three steps later. A set that far along is past
// needing this command — `npm run push` updates it over the LAN.

const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { dirname, join } = require('path');

const ui = require('./ui.js');
const args = require('./args.js');
const { ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const { duidOf, describe, localAddressFor, DEVICE_API_PORT } = require('./tv.js');

const VALUED = ['--privilege', '--password', '--name', '--output'];

// What of this command line belongs to mint. `--duid` is deliberately absent:
// the point of this command is that the device id comes from the television.
const MINT_FLAGS = ['--new-author', '--privilege', '--name', '--password', '--output'];

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

/**
 * Runs one of the other tools, letting it own the terminal.
 *
 * A failure has already explained itself in that tool's own words by the time
 * this sees it — `ui.crash` printed the whole thing — so there is nothing to
 * add, and a second "Failed." would only push the first one up the screen.
 * Exit with the same status and stay quiet.
 */
const run = (script, argv) => {
    try {
        execFileSync('node', [join(__dirname, script)].concat(argv), { cwd: ROOT, stdio: 'inherit' });
    } catch (error) {
        process.exit(typeof error.status === 'number' ? error.status : 1);
    }
};

const main = async () => {
    const argv = args.parse(process.argv.slice(2), VALUED);
    const [ip] = argv.positionals;

    if (!ip) {
        throw friendly(
            'Which TV?\n\n' +
            '  npm run full-bootstrap -- <tv-ip>\n\n' +
            '  Find the address in the TV\'s network settings, or check your router.\n' +
            '  Developer Mode has to be on, with Host PC IP pointed at this machine.'
        );
    }

    // A second positional is almost always a PIN, copied from `mint` or `duid`
    // where it means something. Swallowing it silently would hide the reason
    // this command is about to fail on a set that is pinned to loopback.
    if (argv.positionals.length > 1) {
        throw friendly(
            `This takes one address, and got: ${argv.positionals.join(' ')}\n\n` +
            '  If that second one is a PIN: this command has no use for it. The PIN\n' +
            '  reaches sdbd through Tizen Homebrew, and installing needs sdbd directly,\n' +
            '  which a television pinned to 127.0.0.1 does not allow from here.\n\n' +
            `  A set that far along updates over the LAN:  npm run push -- ${ip} <pin>`
        );
    }

    ui.heading('full-bootstrap', ip);
    ui.blank();

    const device = await describe(ip);

    if (!device) {
        throw friendly(
            `Nothing answered on ${ip}:${DEVICE_API_PORT}.\n\n  Is the TV on, and on this network?`
        );
    }

    ui.info('model', device.modelName || device.model || 'unknown');
    ui.info('dev mode', device.developerMode === '1' ? 'on' : 'OFF');

    if (device.developerMode !== '1') {
        throw friendly(
            'Developer Mode is off on this TV.\n\n' +
            '  On the TV: open Apps, press 12345 (or hold Enter), choose Settings,\n' +
            '  turn Developer mode on, then set\n\n' +
            `    Host PC IP  =  ${localAddressFor(ip) || '<this machine\'s IP>'}\n\n` +
            '  and restart it — that value is only read at startup.'
        );
    }

    // Asked first, before a browser is opened and before anything is built. A
    // Samsung sign-in spent on a television that turns out to be unreachable is
    // a sign-in spent for nothing, and there is no way to hand it back.
    const duid = await duidOf(ip);

    // Not tv.js's whyNoDuid: that one offers the relay as the other way in, and
    // here there is no other way in. Everything below this line needs sdbd to
    // answer this machine, so a silent sdb is the whole command's problem and
    // not just this step's.
    if (!duid) {
        throw friendly(
            `${ip} did not answer with a device id.\n\n` +
            '  That was asked over sdb, and installing needs sdb too, so this is already\n' +
            '  the thing that would stop the install. On the TV: Apps > 12345 (or hold\n' +
            '  Enter) > Settings, set\n\n' +
            `    Host PC IP  =  ${localAddressFor(ip) || '<this machine\'s IP>'}\n\n` +
            '  and restart it — that value is only read at startup.\n\n' +
            '  If this set is already pinned to 127.0.0.1, it is past needing this\n' +
            '  command. Update it over the LAN instead, with the code from its screen:\n\n' +
            `    npm run package && npm run push -- ${ip} <pin>`
        );
    }

    ui.info('duid', duid);

    const found = certificates.locate();
    const covered = certificates.devicesIn(found.distributor, found.distributorPassword);
    const hasAuthor = Boolean(found.password) && existsSync(found.author);

    const newAuthor = argv.has('--new-author');
    const minting = newAuthor || !hasAuthor || covered.indexOf(duid) === -1;

    // The same condition mint applies to the author half, worked out here
    // because what it decides is whether the copy on the TV has to be removed.
    const keepingAuthor = !newAuthor && hasAuthor && covered.length > 0;

    ui.info('signing', minting
        ? `minting for ${duid} — one Samsung sign-in`
        : `the pair in ${dirname(found.distributor)} already covers this TV`);

    ui.blank();

    if (minting) {
        const passthrough = MINT_FLAGS.reduce((all, flag) => {
            if (!argv.has(flag)) return all;
            const value = argv.value(flag);
            return all.concat(value === null ? [flag] : [flag, value]);
        }, []);

        run('mint.js', ['--duid', duid].concat(passthrough));
    }

    run('package.js', []);

    run('bootstrap.js', [ip].concat(keepingAuthor && !argv.has('--replace') ? [] : ['--replace']));

    // bootstrap has just printed the two steps that happen on the television
    // itself. This is the one after those, and it is the step that makes the
    // set able to install anything other than what this machine signed.
    ui.note('Then, once it is back up and Tizen Homebrew is open:');
    ui.blank();
    ui.note(ui.style.dim(`  npm run certs -- ${ip} <the-code-on-screen>`));
    ui.blank();
    ui.note('That hands the TV its own certificates, so it re-signs everything it');
    ui.note('installs from then on — whoever built it.');
    ui.blank();
};

main().catch((err) => ui.crash(err));
