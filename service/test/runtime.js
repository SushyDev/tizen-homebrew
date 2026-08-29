'use strict';

// Engine detection, including the one that cannot be reached from a desk.
//
// lwnode is what some Tizen generations actually run — Node's API on Escargot
// rather than V8 — and the only way to check that this names it correctly,
// short of owning every television Samsung made, is to hand it the version map
// such a runtime reports. So `describe` takes one.

const runtime = require('../src/obs/runtime.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

// What a Tizen set running lwnode reports: Node's API, somebody else's engine.
const LWNODE = {
    version: 'v12.16.3',
    platform: 'linux',
    arch: 'arm',
    versions: { node: '12.16.3', escargot: '1.0.0', modules: '72', uv: '1.34.2' },
    release: { name: 'node' }
};

const MAINLINE = {
    version: 'v12.16.3',
    platform: 'linux',
    arch: 'arm',
    versions: { node: '12.16.3', v8: '7.8.279.23-node.35', modules: '72' },
    release: { name: 'node' }
};

const NEITHER = {
    version: 'v12.16.3',
    platform: 'linux',
    arch: 'arm',
    versions: { node: '12.16.3', modules: '72' },
    release: {}
};

{
    const it = runtime.describe(LWNODE);

    check('lwnode is named by its engine, not its node version',
        it.flavour === 'lwnode' && it.engine === 'Escargot', `${it.flavour}/${it.engine}`);

    check('and still reports the node version it is compatible with',
        it.node === '12.16.3', String(it.node));

    check('the summary says lwnode out loud',
        /lwnode/.test(runtime.summary(LWNODE)), runtime.summary(LWNODE));
}

{
    const it = runtime.describe(MAINLINE);

    check('mainline node is told apart from it on the same node version',
        it.flavour === 'node' && it.engine === 'V8', `${it.flavour}/${it.engine}`);

    check('and its summary does not claim a flavour',
        !/lwnode/.test(runtime.summary(MAINLINE)), runtime.summary(MAINLINE));
}

{
    const it = runtime.describe(NEITHER);

    check('an engine it does not recognise is unknown rather than guessed',
        it.flavour === 'unknown' && it.engine === 'unknown' && it.engineVersion === null,
        `${it.flavour}/${it.engine}`);

    check('and the version map survives so somebody else can name it',
        it.versions && it.versions.node === '12.16.3', JSON.stringify(it.versions));
}

{
    const it = runtime.describe();

    check('the real runtime is described without throwing',
        typeof it.node === 'string' && typeof it.flavour === 'string', JSON.stringify(it));

    check('the ABI is carried when the runtime reports one',
        it.abi === null || typeof it.abi === 'string', String(it.abi));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
