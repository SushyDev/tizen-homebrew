'use strict';

const { execFileSync } = require('child_process');
const { existsSync, mkdirSync, statSync, rmSync, cpSync, readFileSync, writeFileSync } = require('fs');
const { join, dirname } = require('path');

const ui = require('./ui.js');
const { load, ROOT } = require('./config.js');
const certificates = require('./certificates.js');
const packaging = require('../sdk/packaging.js');
const staged = require('../sdk/staging.js');

const DEVELOPER_MARK = 'DEVELOPER BUILD — pin fixed at';

// An allowlist staged into an empty directory, so the package holds exactly these and nothing that
// happened to be lying beside them.
const APP = {
    output: 'release/homebrew.wgt',
    include: [
        'config.xml',
        'icon.png',
        'ui/dist',
        'service/dist'
    ]
};

function friendly(message) {
    const error = new Error(message);
    error.isFriendly = true;
    return error;
}

// The stock Tizen public distributor certificate expired in October 2022 and no retail Samsung set
// ever trusted it, so an unsigned build is the only alternative to a minted pair.
function checkPrerequisites() {
    const found = certificates.locate();
    const absent = certificates.missing(found);

    if (absent.length) {
        throw friendly(
            `Cannot sign:\n  ${absent.join('\n  ')}\n\n  ${certificates.howToMint()}`
        );
    }

    if (!existsSync(found.distributor)) {
        throw friendly(
            'No distributor certificate, and the stock Tizen one does not work:\n' +
            '  a Samsung TV rejects it at install, so this cannot be skipped.\n\n' +
            `  Looked for:  ${found.distributor}\n\n  ${certificates.howToMint()}\n\n` +
            '  That writes author.p12 and distributor.p12 side by side. Point\n' +
            '  TIZEN_AUTHOR_P12 at the author, or set TIZEN_DISTRIBUTOR_P12 explicitly.'
        );
    }

    try {
        return {
            author: certificates.asPem(readFileSync(found.author), found.password),
            distributor: certificates.asPem(readFileSync(found.distributor), found.distributorPassword),
            devices: certificates.devicesIn(found.distributor, found.distributorPassword),
            expiresIn: certificates.expiryOf(found.author, found.password)
        };
    } catch (e) {
        throw friendly(`Cannot read the signing pair:\n\n  ${e.message}`);
    }
}

function stageContents(staging) {
    APP.include.forEach((relativePath) => {
        const from = join(ROOT, relativePath);
        if (!existsSync(from)) {
            throw friendly(
                `${relativePath} is missing, and it must be in the package.\n` +
                '  Run `npm run build` first.'
            );
        }
        const to = join(staging, relativePath);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
    });
}

async function writePackage(pair, directory, outPath) {
    const files = staged.contentsOf(directory);

    writeFileSync(outPath, pair ? await packaging.build(files, pair) : await packaging.pack(files));
}

async function packageApp(certificate) {
    const staging = join(ROOT, '.package');
    const outPath = join(ROOT, APP.output);

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    mkdirSync(join(ROOT, 'release'), { recursive: true });

    const started = Date.now();
    try {
        stageContents(staging);
        await writePackage(certificate, staging, outPath);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }

    if (!existsSync(outPath)) {
        throw friendly(`Packaging reported success but produced no file at ${APP.output}.`);
    }

    return { ms: Date.now() - started, size: statSync(outPath).size, path: APP.output };
}

async function main() {
    const sign = process.argv.indexOf('--sign') !== -1;

    // Set before the config is read and before the rebuild, which is a separate process and inherits
        // the environment but not argv.
    if (process.argv.indexOf('--dev') !== -1) process.env.HOMEBREW_DEV = '1';

    const release = process.argv.indexOf('--release') !== -1;

    const config = load({ requireReal: release });

    const certificate = sign ? checkPrerequisites() : null;

    ui.heading('package', `v${config.version}${sign ? '' : ' unsigned'}`);

    if (certificate && certificate.expiresIn !== null && certificate.expiresIn < 30) {
        ui.warn(certificate.expiresIn > 0
            ? `the author certificate expires in ${certificate.expiresIn} days — mint again before it does`
            : 'the author certificate has expired: packages signed with it are refused at install');
    }

    ui.note(ui.style.dim('  building first...'));
    execFileSync(process.execPath, [join(__dirname, 'build.js')], { cwd: ROOT, stdio: 'inherit' });

    if (release && readFileSync(join(ROOT, 'service/dist/index.js'), 'utf8').indexOf(DEVELOPER_MARK) !== -1) {
        throw Object.assign(new Error(
            'That bundle is a developer build: it pairs with 000000 and evaluates what the\n' +
            '  LAN sends it. Rebuild without HOMEBREW_DEV=1 before releasing.'
        ), { isFriendly: true });
    }

    ui.group(sign ? 'signing' : 'packaging');
    const result = await packageApp(certificate);
    ui.ok('tizen homebrew', `${ui.bytes(result.size)} · ${result.path}`, result.ms);

    ui.blank();
    if (sign) {
        ui.note(certificate.devices.length
            ? `Packaged, signed for ${certificate.devices.join(', ')}.`
            : 'Packaged.');
        ui.note(ui.style.dim('Install with `npm run bootstrap -- <tv-ip>`, or sdb install release/homebrew.wgt'));
    } else {
        ui.note('Packaged, signed by nobody.');
        ui.note(ui.style.dim('This is what a release carries: an installed Tizen Homebrew re-signs it for'));
        ui.note(ui.style.dim('the TV it runs on. A set refuses it over sdb — package with --sign.'));
    }
    ui.blank();
}

main().catch((err) => ui.crash(err));
