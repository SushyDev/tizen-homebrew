'use strict';

// What this television gives the service, as facts for the startup log.
// obs/runtime.js says which engine; this says what it can be asked to do.
//
// Every device-API namespace is a shared object in one directory, so a readdir is
// the whole inventory for a model of set.

const { readdir, stat } = require('fs').promises;

const EXTENSIONS_DIR = '/usr/lib/tizen-extensions-crosswalk';

const LWNODE_BINARY = '/usr/bin/lwnode';

// Three namespaces whose library is not named after them.
const IRREGULAR = {
    'libtizen.so': 'tizen',
    'libtizen_sensor.so': 'tizen.sensorservice',
    'libtizen_tvaudio.so': 'tizen.tvaudiocontrol'
};

/** The namespace a device-API library provides, or null if it is not one. */
const namespaceOf = (file) => {
    if (IRREGULAR[file]) return IRREGULAR[file];

    const tizenApi = /^libtizen_(.+)\.so$/.exec(file);
    if (tizenApi) return `tizen.${tizenApi[1]}`;

    const samsungApi = /^libwebapis_(.+)\.so$/.exec(file);
    if (samsungApi) return `webapis.${samsungApi[1]}`;

    return null;
};

const exists = (path) => stat(path).then(() => true, () => false);

// Model and firmware only. That object also has a `getDuid` and it answers with a
// different number from the one certificates bind to — see tv/sdb.js.
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

/**
 * Device APIs this firmware ships (`available`) and has bound here (`bound`).
 *
 * Object.keys, never a property read: reading one dlopens a shared library.
 */
const deviceApis = async (globals, directory) => {
    const names = await readdir(directory).then(
        (files) => files.map(namespaceOf).filter(Boolean).sort(),
        () => null
    );

    const keysOf = (name) => {
        try {
            const host = globals[name];
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

/**
 * Everything worth knowing about the platform under this service.
 *
 * `proc` and `globals` are injectable so this can be tested without a television.
 */
const describe = async (options) => {
    const opts = options || {};
    const proc = opts.proc || process;
    const globals = opts.globals || (typeof globalThis !== 'undefined' ? globalThis : global);

    const lwnode = proc.lwnode && typeof proc.lwnode === 'object'
        ? {
            present: true,
            methods: Object.keys(proc.lwnode).filter((key) => key[0] !== '_').sort(),
            // Set once AUL names the process, so it also says how it was started.
            asTizenApp: (() => {
                try {
                    return proc.lwnode.hasSystemInfo ? !!proc.lwnode.hasSystemInfo('appid') : null;
                } catch (e) {
                    return null;
                }
            })()
        }
        : { present: false, methods: [], asTizenApp: null };

    // lwnode is built --with-intl=none. Nothing here uses Intl; this keeps it true.
    const intl = typeof globals.Intl !== 'undefined';

    // Blacklisted on lwnode rather than stubbed, so a dependency fails at require.
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

// A host object holds `tizen.filesystem` beside `tizen.TZDate`; case tells them apart.
const callable = (keys) => keys.filter((key) => key[0] === key[0].toLowerCase());

/** The startup lines. A set with no extensions directory says so rather than printing nothing. */
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
