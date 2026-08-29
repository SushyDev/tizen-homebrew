'use strict';

const { readdir, stat } = require('fs').promises;

const EXTENSIONS_DIR = '/usr/lib/tizen-extensions-crosswalk';

const LWNODE_BINARY = '/usr/bin/lwnode';

const IRREGULAR = {
    'libtizen.so': 'tizen',
    'libtizen_sensor.so': 'tizen.sensorservice',
    'libtizen_tvaudio.so': 'tizen.tvaudiocontrol'
};

const namespaceOf = (file) => {
    if (IRREGULAR[file]) return IRREGULAR[file];

    const tizenApi = /^libtizen_(.+)\.so$/.exec(file);
    if (tizenApi) return `tizen.${tizenApi[1]}`;

    const samsungApi = /^libwebapis_(.+)\.so$/.exec(file);
    if (samsungApi) return `webapis.${samsungApi[1]}`;

    return null;
};

const exists = (path) => stat(path).then(() => true, () => false);

const identity = (globals) => {
    const read = (name) => {
        try {
            const info = globals.webapis && globals.webapis.productinfo;
            return info && typeof info[name] === 'function' ? info[name]() || null : null;
        } catch (e) {
            return null;
        }
    };

    return { model: read('getRealModel'), firmware: read('getFirmware') };
};

const deviceApis = async (globals, directory) => {
    const names = await readdir(directory).then(
        (files) => files.map(namespaceOf).filter(Boolean).sort(),
        () => null
    );

    const keysOf = (name) => {
        try {
            const host = globals[name];
            // Object.keys, never a property read: reading one dlopens a shared library.
            return host ? Object.keys(host).sort() : [];
        } catch (e) {
            return [];
        }
    };

    return {
        directory,
        available: names,
        bound: { tizen: keysOf('tizen'), webapis: keysOf('webapis') }
    };
};

const describe = async (options) => {
    const opts = options || {};
    const proc = opts.proc || process;
    const globals = opts.globals || (typeof globalThis !== 'undefined' ? globalThis : global);

    const lwnode = proc.lwnode && typeof proc.lwnode === 'object'
        ? {
            present: true,
            methods: Object.keys(proc.lwnode).filter((key) => key[0] !== '_').sort(),
            asTizenApp: (() => {
                try {
                    return proc.lwnode.hasSystemInfo ? !!proc.lwnode.hasSystemInfo('appid') : null;
                } catch (e) {
                    return null;
                }
            })()
        }
        : { present: false, methods: [], asTizenApp: null };

    const intl = typeof globals.Intl !== 'undefined';

    const v8Module = (() => {
        try {
            require('v8');
            return true;
        } catch (e) {
            return false;
        }
    })();

    const [binary, apis] = await Promise.all([
        exists(opts.lwnodeBinary || LWNODE_BINARY),
        deviceApis(globals, opts.extensionsDir || EXTENSIONS_DIR)
    ]);

    return { lwnode, intl, v8Module, lwnodeBinary: binary, deviceApis: apis, identity: identity(globals) };
};

const callable = (keys) => keys.filter((key) => key[0] === key[0].toLowerCase());

const summary = (facts) => {
    const lines = [];

    if (facts.identity.model) {
        lines.push(`${facts.identity.model}${facts.identity.firmware ? `, firmware ${facts.identity.firmware}` : ''}`);
    }

    lines.push([
        facts.lwnode.present
            ? `process.lwnode present (${facts.lwnode.methods.length} methods` +
              `${facts.lwnode.asTizenApp === true ? ', launched as a tizen app' : ''})`
            : 'no process.lwnode',
        `Intl ${facts.intl ? 'present' : 'ABSENT'}`,
        `require('v8') ${facts.v8Module ? 'resolves' : 'REFUSED'}`,
        `/usr/bin/lwnode ${facts.lwnodeBinary ? 'present' : 'absent'}`
    ].join(', '));

    const { available, bound } = facts.deviceApis;

    if (available === null) {
        lines.push(`no ${facts.deviceApis.directory} — no device-api inventory to read`);
        return lines;
    }

    const apis = { tizen: callable(bound.tizen), webapis: callable(bound.webapis) };
    const constructors = (bound.tizen.length - apis.tizen.length) + (bound.webapis.length - apis.webapis.length);

    lines.push(`${available.length} device apis on this firmware; bound here: ` +
        `${apis.tizen.length} tizen, ${apis.webapis.length} webapis, ${constructors} constructors`);

    ['tizen', 'webapis'].forEach((host) => {
        if (apis[host].length) lines.push(`${host}: ${apis[host].join(' ')}`);
    });

    return lines;
};

module.exports = { describe, summary, namespaceOf, EXTENSIONS_DIR, LWNODE_BINARY };
