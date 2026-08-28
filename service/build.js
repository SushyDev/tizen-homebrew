'use strict';

// Building the service.
//
// One bundler, one pass. This replaces an ncc bundle followed by a Babel
// downlevel, which existed only to make dependency code parse on Tizen 3's
// Node 4.4.3 — and cost 3.9MB of unminified output for the privilege. At a
// Tizen 6.5 floor rolldown does the whole job, minified, in one step.

const { execFileSync } = require('child_process');
const { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');

const { rolldown } = require('rolldown');

const { load } = require('../tools/config.js');
const { injectTokens } = require('../tools/inject.js');
const ui = require('../tools/ui.js');

const root = __dirname;
const outDir = join(root, 'dist');

// Measured on Tizen 6.5: v12.16.3. Anything older is untested, so this is the
// floor the build guarantees rather than one inferred from release notes.
const TARGET = 'node12';

const buildStamp = (version) => {
    const sha = (() => {
        try {
            return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        } catch (e) {
            return 'nogit';
        }
    })();

    return `${version}+${sha}.${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
};

const main = async () => {
    const config = load();
    const stamp = buildStamp(config.version);

    ui.heading('build service', stamp);

    const bundle = await rolldown({
        input: join(root, 'src', 'main.js'),
        platform: 'node',
        transform: { target: TARGET }
    });

    const { output } = await bundle.generate({ format: 'cjs', minify: true });
    const entry = output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);

    // Both tokens must be present and both must be gone afterwards; a silently
    // unreplaced origin produces a service that never reaches its CDN.
    const { code } = injectTokens(entry.code, {
        __HOMEBREW_BUILD__: stamp,
        __HOMEBREW_ORIGIN__: config.catalogUrl.replace(/\/catalog\.json$/, '')
    });

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.js'), code);

    // Assets rolldown emitted alongside the entry, if any dependency ships one.
    output
        .filter((chunk) => chunk.type === 'asset')
        .forEach((asset) => {
            writeFileSync(join(outDir, asset.fileName), asset.source);
            ui.ok('asset', asset.fileName);
        });

    // Tizen's service runtime calls module.exports.onStart(). A bundle
    // without it installs cleanly, reports itself as running, and never
    // listens — which is indistinguishable from a crash until you go looking.
    if (!/onStart/.test(code)) {
        throw Object.assign(
            new Error('The bundle does not export onStart, so Tizen would never start the service.'),
            { isFriendly: true }
        );
    }

    const bytes = Buffer.byteLength(code);
    ui.ok('bundle', `${ui.bytes(bytes)}  (${bytes.toLocaleString()} bytes)`);

    // The floor is checked rather than assumed: a dependency using syntax the
    // target cannot parse would otherwise only surface on the TV.
    execFileSync('node', [join(root, 'check-syntax.js'), join(outDir, 'index.js')], { stdio: 'inherit' });

    const previous = join(root, '..', '.last-build-size');
    if (existsSync(previous)) {
        const was = Number(readFileSync(previous, 'utf8'));
        const delta = bytes - was;
        ui.note(`  ${delta <= 0 ? 'down' : 'up'} ${ui.bytes(Math.abs(delta))} from the previous build`);
    }
    writeFileSync(previous, String(bytes));

    ui.blank();
};

main().catch((error) => ui.crash(error));
