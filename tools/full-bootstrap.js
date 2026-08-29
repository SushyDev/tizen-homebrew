'use strict';

const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { dirname, join } = require('path');

const ui = require('./ui.js');
const args = require('./args.js');
const { ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const { duidOf, describe, localAddressFor, DEVICE_API_PORT } = require('./tv.js');

const VALUED = ['--privilege', '--password', '--name', '--output'];

const MINT_FLAGS = ['--new-author', '--privilege', '--name', '--password', '--output'];

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const run = (script, argv) => {
    try {
        execFileSync(process.execPath, [join(__dirname, script)].concat(argv), { cwd: ROOT, stdio: 'inherit' });
    } catch (error) {
        process.exit(typeof error.status === 'number' ? error.status : 1);
    }
};

// mint, then package, then bootstrap, against one address — so a device id is never carried
// between them by hand. `--replace` goes to bootstrap whenever the author certificate is about to
// change, since Tizen will not update across one.
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

    const duid = await duidOf(ip);

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

    run('package.js', ['--sign']);

    run('bootstrap.js', [ip].concat(keepingAuthor && !argv.has('--replace') ? [] : ['--replace']));

    ui.note('The certificates went with it, so the TV already re-signs whatever it');
    ui.note('installs — whoever built it. Nothing else to run.');
    ui.blank();
};

main().catch((err) => ui.crash(err));
