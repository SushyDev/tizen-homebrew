'use strict';

// Minting a certificate pair for one television. Point it at an address and it resolves the DUID
// itself, which is the way round that cannot go wrong.
//
// One distributor certificate names several devices, so a second set adds to the list; the author
// certificate is kept, because Tizen refuses to update across a changed one and recovering needs sdb.

const { existsSync } = require('fs');

const ui = require('./ui.js');
const args = require('./args.js');
const certificates = require('./certificates.js');
const minting = require('./minting.js');
const { duidOf, whyNoDuid } = require('./tv.js');

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const VALUED = ['--duid', '--privilege', '--password', '--name', '--output'];

const main = async () => {
    const argv = args.parse(process.argv.slice(2), VALUED);
    const named = (flag) => argv.value(flag);

    const [ip, pin] = argv.positionals;
    // Partner is needed for the service's on-boot and auto-restart declarations.
    // Keep an explicit public path for sets or accounts that cannot mint Partner.
    const privilege = argv.has('--public') ? 'Public' : (named('--privilege') || 'Partner');
    const password = named('--password') || Math.random().toString(36).slice(2, 12);

    ui.heading('mint');
    ui.blank();

    // Asking is the whole point: a pair minted against the wrong device id signs packages that upload and are
    // then refused, naming neither.
    const listed = named('--duid');

    const asked = listed
        ? listed.split(',').map((device) => device.trim()).filter(Boolean)
        : (ip ? [await duidOf(ip, pin)].filter(Boolean) : []);

    if (!ip && !asked.length) {
        throw friendly(
            'Which television?\n\n' +
            '  npm run mint -- <tv-ip>              ask the TV over sdb\n' +
            '  npm run mint -- <tv-ip> <pin>        ask Tizen Homebrew on the TV\n' +
            '  npm run mint -- --duid <DUID>        when you already know it\n' +
            '  npm run mint -- --duid <A>,<B>,<C>   several at once\n\n' +
            '  Add --public to mint a public certificate instead of the default Partner one.'
        );
    }

    if (!asked.length) throw friendly(whyNoDuid(ip, pin));

    const existing = certificates.locate();
    const covered = certificates.devicesIn(existing.distributor, existing.distributorPassword);

    const devices = asked.reduce(
        (all, device) => (all.indexOf(device) === -1 ? all.concat(device) : all),
        covered
    );

    const keeping = !argv.has('--new-author') && Boolean(existing.password) && existsSync(existing.author) && covered.length > 0;

    if (ip && !listed) ui.info('asked', `${ip} ${pin ? 'through Tizen Homebrew' : 'over sdb'}`);

    ui.info('adding', asked.map((device) => device + (covered.indexOf(device) === -1 ? '' : ' (already covered)')).join(', '));
    ui.info('covering', devices.join(', '));
    ui.info('author', keeping ? 'keeping the one on this machine' : 'minting a new one');
    ui.info('privilege', privilege);
    ui.blank();

    ui.note('Sign in to your Samsung account:');
    ui.blank();
    ui.note(ui.style.dim(`  ${minting.SIGN_IN}`));
    ui.blank();
    ui.note('Waiting for the browser to come back...');

    const account = await minting.signIn();

    ui.blank();
    ui.ok('signed in', account.email || account.userId);

    const authorInfo = {
        name: named('--name') || (account.email || 'tizen-homebrew').split('@')[0],
        email: account.email,
        password: keeping ? existing.password : password,
        privilegeLevel: privilege
    };

    const minted = await minting.mint(account, authorInfo, devices, keeping);

    const directory = named('--output') || certificates.DEFAULT_DIR;

    minting.write(directory, minted, keeping, password, existing);

    ui.ok('written', directory);
    ui.info('profile', minted.profileFrom === 'samsung'
        ? 'device-profile.xml, as Samsung issued it'
        : 'device-profile.xml, holding the distributor certificate — Samsung served no profile');
    ui.blank();

    ui.note(keeping
        ? 'The author certificate is unchanged, so televisions already running this keep updating.'
        : 'A new author certificate. Any television already running this needs `--replace` once:');

    if (!keeping) ui.note(ui.style.dim('  npm run bootstrap -- <tv-ip> --replace   (needs sdb — see the README)'));

    ui.blank();
    ui.note(`This pair signs for ${devices.length === 1 ? devices[0] : `${devices.length} televisions: ${devices.join(', ')}`}.`);

    // Everything else reads ~/.tizen-certs unless pointed elsewhere, and this pair is elsewhere.
    if (directory !== certificates.DEFAULT_DIR) {
        ui.note(ui.style.dim(`  export TIZEN_AUTHOR_P12=${directory}/author.p12`));
    }

    ui.note(ui.style.dim('  npm run package -- --sign                build a widget they can install'));
    ui.note(ui.style.dim(`  npm run certs -- ${ip || '<tv-ip>'} <pin>          let a TV re-sign for itself`));
    ui.blank();
};

main().catch((err) => ui.crash(err));
