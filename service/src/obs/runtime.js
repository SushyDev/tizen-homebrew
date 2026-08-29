'use strict';

// Which JavaScript engine is this, really?
//
// `process.version` answers "what Node does it claim compatibility with",
// which is not the same question. Samsung ships lwnode — Node's API surface on
// top of Escargot rather than V8 — on some Tizen generations, and a build that
// works on mainline Node of the same version can still fail there, because the
// engine underneath is a different implementation with different limits.
//
// Reading `v8` or `escargot` out of process.versions distinguishes them, and
// costs nothing at startup. It is reported rather than inferred: the map is
// printed as the runtime supplies it, and the friendly label is derived from
// it rather than substituted for it — an evening was lost to a log that named
// a cause instead of a symptom, and this is the same mistake in miniature.
//
// Node 12 is the floor, so no optional chaining and no nullish coalescing.

// Engines seen in the wild under a Node-compatible API, most specific first.
// Escargot is Samsung's; JerryScript turns up on smaller Tizen profiles.
const ENGINES = [
    { key: 'escargot', label: 'Escargot', flavour: 'lwnode' },
    { key: 'jerryscript', label: 'JerryScript', flavour: 'iotjs' },
    { key: 'v8', label: 'V8', flavour: 'node' }
];

/**
 * What is running this, as facts plus a label derived from them.
 *
 * Never throws and never guesses: an engine it does not recognise is reported
 * as unknown with the version map intact, which is enough for somebody to name
 * it from the other end of a log.
 */
const describe = (from) => {
    // `from` exists so lwnode can be tested on a laptop. Nothing in this file
    // can be exercised on the runtime it is written for without a television,
    // and a detector that has only ever seen V8 is a detector nobody has
    // tested — which is how the last one-line assumption got onto a set.
    const source = from || process;
    const versions = source.versions || {};
    const release = source.release || {};

    const found = ENGINES.filter((engine) => versions[engine.key])[0] || null;

    return {
        // What it says it is compatible with.
        node: versions.node || String(source.version || '').replace(/^v/, ''),

        // What is actually executing the code.
        engine: found ? found.label : 'unknown',
        engineVersion: found ? versions[found.key] : null,
        flavour: found ? found.flavour : 'unknown',

        platform: source.platform,
        arch: source.arch,

        // The ABI a native module would have to match, and the release channel.
        // Both are the sort of thing that turns "it works on mine" into a
        // difference somebody can name.
        abi: versions.modules || null,
        releaseName: release.name || null,
        lts: release.lts || null,

        // Kept whole. Whatever the label got wrong, this did not.
        versions
    };
};

/** One line for the startup log. */
const summary = (from) => {
    const it = describe(from);

    const engine = it.engineVersion
        ? `${it.engine} ${String(it.engineVersion).split('-')[0]}`
        : it.engine;

    // "node 12.16.3" is what a person looks for; the engine is what tells them
    // whether it is the runtime they think it is.
    return `node ${it.node} (${it.flavour === 'node' ? engine : `${it.flavour}, ${engine}`})` +
        ` on ${it.platform}/${it.arch}` +
        (it.abi ? `, abi ${it.abi}` : '');
};

module.exports = { describe, summary, ENGINES };
