'use strict';

// Samsung ships lwnode — Node's API on Escargot — so `process.version` answers a different question.
const ENGINES = [
    { key: 'escargot', label: 'Escargot', flavour: 'lwnode' },
    { key: 'jerryscript', label: 'JerryScript', flavour: 'iotjs' },
    { key: 'v8', label: 'V8', flavour: 'node' }
];

const describe = (from) => {
    const source = from || process;
    const versions = source.versions || {};
    const release = source.release || {};

    const found = ENGINES.filter((engine) => versions[engine.key])[0] || null;

    return {
        node: versions.node || String(source.version || '').replace(/^v/, ''),

        engine: found ? found.label : 'unknown',
        engineVersion: found ? versions[found.key] : null,
        flavour: found ? found.flavour : 'unknown',

        platform: source.platform,
        arch: source.arch,

        abi: versions.modules || null,
        releaseName: release.name || null,
        lts: release.lts || null,

        versions
    };
};

const summary = (from) => {
    const it = describe(from);

    const engine = it.engineVersion
        ? `${it.engine} ${String(it.engineVersion).split('-')[0]}`
        : it.engine;

    return `node ${it.node} (${it.flavour === 'node' ? engine : `${it.flavour}, ${engine}`})` +
        ` on ${it.platform}/${it.arch}` +
        (it.abi ? `, abi ${it.abi}` : '');
};

module.exports = { describe, summary, ENGINES };
