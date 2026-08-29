'use strict';

// Runs the bundle smoke test on every Node this service has to survive.
//
//   npm run test:matrix
//   npm run test:matrix -- --serial
//   npm run test:matrix -- 12.16.3 18.18.2
//
// Three televisions of three Samsung generations run three different Node
// versions, and a bundle is built once for all of them. That is the whole
// problem: `require('fs/promises')` is valid everywhere from Node 14 and
// resolves nowhere before it, so a build that passed every check on a laptop
// running Node 24 installed cleanly, launched, and never opened its port —
// with no log to say why, because the service died on its first require.
//
// The syntax floor in check-syntax.js walks the AST and cannot see that: a
// module specifier is not syntax. Actually loading the bundle under an old
// runtime can, and takes about a second.

const { execFile } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');

// Every major from the oldest television forward.
//
// The Tizen-to-Node mapping is not published anywhere, so the ones that have
// actually been read off a set are marked and the rest are covered by testing
// the major instead of guessing which set uses it. Testing a version nothing
// runs costs a second; missing one costs an evening.
// Every Node this bundle has to survive, and which television runs it.
//
//   Tizen  Year  Chromium  V8           Runtime
//   10.0   2026  M130      12.x / 13.x  node 18.18.2+
//   9.0    2025  M120      12.0.267.1   node 18.18.2      · both verified on a set
//   8.0    2024  M108      10.8         node 12.16.3, transitional
//   7.0    2023  M94       9.4          node 12.16.3
//   6.5    2022  M85       8.5          node 12.16.3      · verified
//   6.0    2021  M76       7.6          node 12.16.3
//   5.5    2020  M69       6.9          legacy lwnode snapshot
//   5.0    2019  M63       6.3          legacy lwnode snapshot
//   4.0    2018  M56       5.6          early lwnode
//
// Two mainline runtimes cover Tizen 6.0 through 10: 12.16.3 and 18.18.2. The
// versions in between are not known to run on any television and are tested
// regardless — a spare second each, against the alternative of finding out
// from a set that a release does not start.
//
// Below Tizen 6.0 the runtime is lwnode rather than mainline Node, and an
// lwnode snapshot does not carry a mainline version number fnm can install. So
// nothing here tests one directly, and 10.24.1 stands in as margin beneath the
// oldest mainline runtime. runtime.js names lwnode when it sees it, so the
// first such set to report in will settle what its API level actually is.
const TARGETS = [
    { node: '12.16.3', note: 'Tizen 6.0, 6.5, 7.0, 8.0 — verified on 6.5' },
    { node: '14.21.3', note: 'no set runs it — first with require("fs/promises")' },
    { node: '16.20.2', note: 'no set runs it' },
    { node: '18.18.2', note: 'Tizen 9.0 and 10.0 — verified on 9.0' },
    { node: '20.18.1', note: 'newer than any set — margin' },
    { node: '22.12.0', note: 'newer than any set — margin' }
];

// The oldest mainline runtime any television is known to use.
//
// Versions below it are still run, because knowing how far down the bundle
// actually works is worth a second — and it is not idle curiosity here, since
// Tizen 4.0 to 5.5 run lwnode snapshots whose API level is not documented
// anywhere in this repo. They cannot fail the suite, though: a red mark for a
// runtime nothing is known to use is how a check stops being read.
//
// The two things that break first are already known, if this ever has to drop:
// `flatMap` in main.js needs Node 11, and the minifier emits optional catch
// binding, which needs Node 10.
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

    // Each run gets its own port, which is the only thing that would collide,
    // so parallel is the default and --serial is for when a machine would
    // rather not start eight node processes at once.
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
