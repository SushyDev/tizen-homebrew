'use strict';

const { execFileSync } = require('child_process');
const {
    existsSync, mkdirSync, statSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync
} = require('fs');
const { join, dirname, relative, sep } = require('path');

const JSZip = require('jszip');

const ui = require('./ui.js');
const { load, ROOT } = require('./config.js');
const { which, runSync } = require('./which.js');
const certificates = require('./certificates.js');

const DEVELOPER_MARK = 'DEVELOPER BUILD — pin fixed at';

// tizenjs's --ignore matches basenames only, so it cannot express "keep service/dist/index.js but
// drop service/index.js". Staging an allowlist instead makes the package contents exact.
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

// Left to itself tizenjs signs with the stock Tizen public distributor certificate, which expired
// in October 2022 and which no retail Samsung set ever trusted — the package builds and is refused
// at install with "Invalid certificate chain".
function checkPrerequisites() {
    const tizenjs = which('tizenjs');
    if (!tizenjs) {
        throw friendly(
            'tizenjs was not found. It ships as a dependency, so this usually\n' +
            '  means the install is incomplete. Run: npm install'
        );
    }

    const found = certificates.locate();
    const absent = certificates.missing(found);

    if (absent.length) {
        throw friendly(
            `Cannot sign:\n  ${absent.join('\n  ')}\n\n  ${certificates.howToMint()}`
        );
    }

    const p12 = found.author;
    const password = found.password;

    if (!existsSync(p12)) {
        throw friendly(`TIZEN_AUTHOR_P12 points at a file that does not exist:\n  ${p12}`);
    }

    const distributor = found.distributor;

    const distributorPassword = found.distributorPassword;

    if (!existsSync(distributor)) {
        throw friendly(
            'No distributor certificate, and the stock Tizen one does not work:\n' +
            '  a Samsung TV rejects it at install, so this cannot be skipped.\n\n' +
            `  Looked for:  ${distributor}\n\n  ${certificates.howToMint()}\n\n` +
            '  That writes author.p12 and distributor.p12 side by side. Point\n' +
            '  TIZEN_AUTHOR_P12 at the author, or set TIZEN_DISTRIBUTOR_P12 explicitly.'
        );
    }

    return { p12, password, distributor, distributorPassword, tizenjs };
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

function signWith(certificate, staging, outPath) {
    try {
        runSync(certificate.tizenjs, [
            'build', '.',
            '-t', 'wgt',
            '-o', outPath,
            '--author', certificate.p12,
            '--authorPwd', certificate.password,
            '--distributor', certificate.distributor,
            '--distributorPwd', certificate.distributorPassword
        ], { cwd: staging, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
        const output = `${e.stdout || ''}${e.stderr || ''}`.trim();
        throw friendly(`Packaging failed.\n\n${output || e.message}`);
    }
}

// A .wgt is a zip, and all tizenjs adds beyond one is the pair of signature files. Same library and
// same walk, so an unsigned package differs from a signed one in exactly two entries.
async function zipUnsigned(staging, outPath) {
    const zip = new JSZip();

    (function add(directory) {
        readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return add(path);
            zip.file(relative(staging, path).split(sep).join('/'), readFileSync(path));
        });
    })(staging);

    writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
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
        if (certificate) signWith(certificate, staging, outPath);
        else await zipUnsigned(staging, outPath);
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
        ui.note('Packaged.');
        ui.note(ui.style.dim('Install with `npm run bootstrap -- <tv-ip>`, or sdb install release/homebrew.wgt'));
    } else {
        ui.note('Packaged, signed by nobody.');
        ui.note(ui.style.dim('This is what a release carries: an installed Tizen Homebrew re-signs it for'));
        ui.note(ui.style.dim('the TV it runs on. A set refuses it over sdb — package with --sign.'));
    }
    ui.blank();
}

main().catch((err) => ui.crash(err));
