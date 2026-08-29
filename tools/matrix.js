'use strict';

const { execFile } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');

// Runs the bundle smoke test on every Node this service has to survive.
//
//   npm run test:matrix [-- --serial] [-- 12.16.3 18.18.2]
//
// check-syntax.js walks the AST and cannot see that `require('fs/promises')` resolves nowhere
// before Node 14 — a build that passed every check on a laptop installed, launched and never
// opened its port. Actually loading the bundle under an old runtime catches it, in about a second.
//
// Tizen 6.0 through 10 run node 12.16.3 or 18.18.2; below 6.0 the runtime is an lwnode snapshot
// with no mainline version number to install, so 10.24.1 stands in as margin.
const TARGETS = [
    { node: '12.16.3', note: 'Tizen 6.0, 6.5, 7.0, 8.0 — verified on 6.5' },
    { node: '14.21.3', note: 'no set runs it — first with require("fs/promises")' },
    { node: '16.20.2', note: 'no set runs it' },
    { node: '18.18.2', note: 'Tizen 9.0 and 10.0 — verified on 9.0' },
    { node: '20.18.1', note: 'newer than any set — margin' },
    { node: '22.12.0', note: 'newer than any set — margin' }
];

// Versions below the floor are still run but cannot fail the suite.
const FLOOR = 12;

const major = (version) => Number(String(version).split('.')[0]);

const BASE_PORT = 8390;
const SMOKE = join(ROOT, 'service', 'test', 'smoke.js');

const run = (command, args, options) => new Promise((resolve) => {
    execFile(command, args, options || {}, (error, stdout, stderr) => {
        resolve({ ok: !error, code: error ? error.code : 0, out: `${stdout || ''}${stderr || ''}` });
    });
});

const main = async () => {
    const args = process.argv.slice(2);
    const serial = args.indexOf('--serial') !== -1;
    const wanted = args.filter((argument) => argument[0] !== '-');

    const targets = wanted.length
        ? TARGETS.filter((target) => wanted.some((v) => target.node.indexOf(v) === 0))
        : TARGETS;

    if (!targets.length) {
        throw Object.assign(new Error(`No target matches ${wanted.join(', ')}.`), { isFriendly: true });
    }

    if (!existsSync(join(ROOT, 'service', 'dist', 'index.js'))) {
        throw Object.assign(
            new Error('No bundle to test. Run `npm run build` first.'), { isFriendly: true }
        );
    }

    const fnm = await run('fnm', ['--version']);

    if (!fnm.ok) {
        throw Object.assign(new Error(
            'fnm is not installed, and it is what switches Node versions here.\n\n' +
            '  brew install fnm      or see https://github.com/Schniz/fnm\n\n' +
            '  CI runs the same matrix with actions/setup-node, so this is a local convenience.'
        ), { isFriendly: true });
    }

    ui.heading('test:matrix', `${targets.length} node versions · ${serial ? 'serial' : 'parallel'}`);
    ui.blank();

    const attempt = async (target, index) => {
        const started = Date.now();

        const installed = await run('fnm', ['install', target.node], { cwd: ROOT });

        if (!installed.ok && !/already installed/i.test(installed.out)) {
            return { target, state: 'unavailable', detail: installed.out.trim().split('\n').pop() };
        }

        const result = await run(
            'fnm', ['exec', `--using=${target.node}`, '--', 'node', SMOKE],
            { cwd: ROOT, env: { ...process.env, HOMEBREW_PORT: String(BASE_PORT + 10 + index) } }
        );

        return {
            target,
            state: result.ok ? 'passed' : 'failed',
            ms: Date.now() - started,
            detail: result.ok ? null : result.out.split('\n').filter((l) => /FAIL|Error/.test(l))[0] || result.out.trim().split('\n').pop()
        };
    };

    const results = [];

    if (serial) {
        for (let index = 0; index < targets.length; index++) {
            results.push(await attempt(targets[index], index));
        }
    } else {
        results.push(...await Promise.all(targets.map(attempt)));
    }

    results.forEach((result) => {
        const label = `node ${result.target.node}`;

        if (result.state === 'passed') return ui.ok(label, result.target.note, result.ms);
        if (result.state === 'unavailable') return ui.warn(`${label.padEnd(32)}not installable here — ${result.detail}`);

        if (major(result.target.node) < FLOOR) {
            return ui.note(`  ${ui.style.dim('·')} ${label.padEnd(30)} ${ui.style.dim(`below the floor: ${result.detail}`)}`);
        }

        ui.fail(label, result.detail);
    });

    ui.blank();

    const failed = results.filter((result) =>
        result.state === 'failed' && major(result.target.node) >= FLOOR);
    const skipped = results.filter((result) => result.state === 'unavailable');

    if (skipped.length) {
        ui.note(ui.style.dim(`  ${skipped.length} version(s) could not be installed on this platform — CI covers those.`));
    }

    if (failed.length) {
        ui.note(`${failed.length} of ${results.length} failed at or above the Node ${FLOOR} floor.`);
        process.exit(1);
    }

    const below = results.filter((result) =>
        result.state === 'failed' && major(result.target.node) < FLOOR).length;

    ui.note(`Every version from Node ${FLOOR} up loaded and answered` +
        (below ? `, and ${below} older one(s) did not — which is allowed.` : '.'));
    ui.blank();
};

main().catch((err) => ui.crash(err));
