'use strict';

const { execFileSync } = require('child_process');
const { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');

const { rolldown } = require('rolldown');

const { load } = require('../tools/config.js');
const { injectTokens } = require('../tools/inject.js');
const ui = require('../tools/ui.js');

const root = __dirname;
const outDir = join(root, 'dist');

const TARGET = 'node12';

// A bundle over this is a bundle that has quietly picked up a dependency it does not need.
const CEILING = 350 * 1024;

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
        transform: {
            target: TARGET,
            define: { 'globalThis.__HOMEBREW_DEV__': config.dev ? 'true' : 'false' }
        }
    });

    const { output } = await bundle.generate({ format: 'cjs', minify: true });
    const entry = output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);

    const { code } = injectTokens(entry.code, {
        __HOMEBREW_BUILD__: stamp,
        __HOMEBREW_ORIGIN__: config.catalogUrl.replace(/\/catalog\.json$/, '')
    });

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.js'), code);

    const marked = /DEVELOPER BUILD/.test(code);

    if (config.dev !== marked) {
        throw Object.assign(new Error(config.dev
            ? 'HOMEBREW_DEV=1 but the bundle has no developer branch in it.'
            : 'This is not a developer build, but the REPL survived into the bundle.'),
        { isFriendly: true });
    }

    output
        .filter((chunk) => chunk.type === 'asset')
        .forEach((asset) => {
            writeFileSync(join(outDir, asset.fileName), asset.source);
            ui.ok('asset', asset.fileName);
        });

    if (!/onStart/.test(code)) {
        throw Object.assign(
            new Error('The bundle does not export onStart, so Tizen would never start the service.'),
            { isFriendly: true }
        );
    }

    const bytes = Buffer.byteLength(code);
    ui.ok('bundle', `${ui.bytes(bytes)}  (${bytes.toLocaleString()} bytes)`);

    if (bytes > CEILING) {
        throw Object.assign(new Error(
            `The bundle is ${ui.bytes(bytes)}, over the ${ui.bytes(CEILING)} ceiling.\n` +
            '  Something large arrived with a dependency. `npm ls <package> --all` names\n' +
            '  what pulled it in; importing the one file you need usually undoes it.'
        ), { isFriendly: true });
    }

    execFileSync(process.execPath, [join(root, 'check-syntax.js'), join(outDir, 'index.js')], { stdio: 'inherit' });

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
