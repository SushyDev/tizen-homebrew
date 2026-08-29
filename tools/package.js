'use strict';

// Signs and packages the .wgt.
//
//   npm run package                signed for this machine's television
//   npm run package -- --unsigned  signed by nobody, for Tizen Homebrew
//
// A signature names the television it may be installed on — the device id is
// in the distributor certificate, and Tizen 7 enforces it — so a signed build
// is for `npm run bootstrap` onto your own set. Tizen Homebrew re-signs
// everything it installs, itself included, so the unsigned .wgt is the one
// that reaches anybody else's TV. That is what a release carries; a TV will
// not take it over sdb.
//
// Always builds first: packaging stale output is the kind of mistake that
// costs an hour of confused debugging on the TV.

const { execFileSync } = require('child_process');
const {
    existsSync, mkdirSync, statSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync
} = require('fs');
const { join, dirname, relative, sep } = require('path');

const JSZip = require('jszip');

const ui = require('./ui.js');
const { load, ROOT } = require('./config.js');
const { which } = require('./which.js');
const certificates = require('./certificates.js');

// What actually goes into each .wgt, named explicitly.
//
// tizenjs's --ignore matches basenames only, so it cannot express "keep
// service/dist/index.js but drop service/index.js". Staging an allowlist
// instead makes the package contents exact and auditable: nothing ships
// unless it is listed here.
// The sentence main.js logs in a developer build. A string literal, so the
// minifier keeps it verbatim, which makes it a reliable mark on the artifact.
const DEVELOPER_MARK = 'DEVELOPER BUILD — pin fixed at';

const APP = {
    output: 'release/tizenhomebrew.wgt',
    include: [
        'config.xml',
        'icon.png',
        // Vite emits both pages here: index.html for the phone, tv.html for
        // the screen, and theme.wav beside them. config.xml points at tv.html.
        'ui/dist',
        'service/dist'
    ]
};

function friendly(message) {
    const error = new Error(message);
    error.isFriendly = true;
    return error;
}

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

    // The distributor half matters as much as the author half, and it is the
    // one that is easy to get wrong. Left to itself tizenjs falls back to the
    // stock Tizen public distributor signer: a Tizen Test CA certificate that
    // expired in October 2022, and that a retail Samsung TV never trusted in
    // the first place. Packages signed with it build fine and are refused at
    // install with
    //
    //   install failed[118, -12] Invalid certificate chain with certificate
    //   in signature
    //
    // which says nothing about which of the two signatures is at fault.
    // Samsung mints both halves together, bound to the TV's DUID, so the
    // distributor p12 normally sits beside the author one.
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

// Copies the allowlist into an empty directory: the package as it will be
// read. A missing entry is a build problem, not something to quietly ship
// without.
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
        execFileSync(certificate.tizenjs, [
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

// A .wgt is a zip, and the only thing tizenjs adds beyond one is the pair of
// signature files. Same library, same options, same walk — so an unsigned
// package differs from a signed one in exactly two entries, which is what
// makes `install/resign.js` on the TV able to treat the two alike.
async function zipUnsigned(staging, outPath) {
    const zip = new JSZip();

    (function add(directory) {
        readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return add(path);
            // config.xml has to sit at the package root, so paths are stored
            // relative to it, with the separator a zip is specified in.
            zip.file(relative(staging, path).split(sep).join('/'), readFileSync(path));
        });
    })(staging);

    writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// The certificate is null for an unsigned package, and that is the only
// difference after staging.
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
    const unsigned = process.argv.indexOf('--unsigned') !== -1;

    // Set before the config is read and before the rebuild below, which is a
    // separate process and inherits the environment but not the flag. Without
    // this, `npm run build -- --dev && npm run package` quietly packages the
    // ordinary bundle the rebuild just overwrote.
    if (process.argv.indexOf('--dev') !== -1) process.env.HOMEBREW_DEV = '1';

    // A release build refuses a placeholder catalogue URL. The URL is baked
    // into the package and every TV that installs it, so shipping the example
    // host produces an app whose catalogue is permanently empty.
    const release = process.argv.indexOf('--release') !== -1;

    const config = load({ requireReal: release });

    // Before the build, so a missing certificate costs a second rather than
    // the whole build.
    const certificate = unsigned ? null : checkPrerequisites();

    // Build first so the package can never contain stale bundles.
    ui.heading('package', `v${config.version}${unsigned ? ' unsigned' : ''}`);
    ui.note(ui.style.dim('  building first...'));
    execFileSync('node', [join(__dirname, 'build.js')], { cwd: ROOT, stdio: 'inherit' });

    // Belt to config.js's braces. That refuses HOMEBREW_DEV=1 outright and is
    // what actually catches this, since packaging rebuilds first and a rebuild
    // without the variable cannot produce a developer bundle. This reads the
    // artifact anyway, because it is the artifact that gets zipped.
    if (release && readFileSync(join(ROOT, 'service/dist/index.js'), 'utf8').indexOf(DEVELOPER_MARK) !== -1) {
        throw Object.assign(new Error(
            'That bundle is a developer build: it pairs with 000000 and evaluates what the\n' +
            '  LAN sends it. Rebuild without HOMEBREW_DEV=1 before releasing.'
        ), { isFriendly: true });
    }

    ui.group(unsigned ? 'packaging' : 'signing');
    const result = await packageApp(certificate);
    ui.ok('tizen homebrew', `${ui.bytes(result.size)} · ${result.path}`, result.ms);

    ui.blank();
    if (unsigned) {
        ui.note('Packaged, signed by nobody.');
        ui.note(ui.style.dim('This is what a release carries: an installed Tizen Homebrew re-signs it for'));
        ui.note(ui.style.dim('the TV it runs on. A set refuses it over sdb — package without --unsigned.'));
    } else {
        ui.note('Packaged.');
        ui.note(ui.style.dim('Install with `npm run bootstrap -- <tv-ip>`, or sdb install release/tizenhomebrew.wgt'));
    }
    ui.blank();
}

main().catch((err) => ui.crash(err));
