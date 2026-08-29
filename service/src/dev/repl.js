'use strict';

const { inspect } = require('util');

const DEPTH = 2;
const MAX_OUTPUT = 16 * 1024;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const trailingExpression = (source) => {
    const body = source.trim().replace(/;$/, '');
    const at = Math.max(body.lastIndexOf(';'), body.lastIndexOf('\n'));

    if (at === -1) return null;

    const tail = body.slice(at + 1).trim();

    if (!tail) return null;

    try {
        new AsyncFunction(`return (${tail});`);
    } catch (e) {
        return null;
    }

    return `${body.slice(0, at + 1)} return (${tail});`;
};

// `new Function` rather than `vm`: the point is to reach into this process, and lwnode has no vm module.
const compile = (source, names) => {
    const candidates = [`return (${source});`, trailingExpression(source), source].filter(Boolean);

    let last;

    for (const candidate of candidates) {
        try {
            return new AsyncFunction(...names, candidate);
        } catch (error) {
            last = error;
        }
    }

    throw last;
};

const truncate = (text) => (text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n… ${text.length - MAX_OUTPUT} more characters`
    : text);

const createRepl = (context) => {
    const scope = { ...context };
    scope.$ = scope;

    const names = Object.keys(scope);
    const values = names.map((name) => scope[name]);

    const evaluate = async (source) => {
        if (typeof source !== 'string' || !source.trim()) {
            return { ok: false, error: 'Nothing to evaluate.' };
        }

        let run;
        try {
            run = compile(source, names);
        } catch (error) {
            return { ok: false, error: `Could not compile: ${error.message}` };
        }

        try {
            const value = await run(...values);

            return {
                ok: true,
                type: value === null ? 'null' : typeof value,
                value: truncate(inspect(value, { depth: DEPTH, maxArrayLength: 100, breakLength: 100 }))
            };
        } catch (error) {
            return { ok: false, error: truncate((error && error.stack) || String(error)) };
        }
    };

    const openInspector = (port) => {
        let inspector;

        try {
            inspector = require('inspector');
        } catch (error) {
            return { ok: false, error: 'This runtime has no inspector module — lwnode is built without one.' };
        }

        try {
            const already = inspector.url();
            if (already) return { ok: true, url: already, alreadyOpen: true };

            inspector.open(port || 9229, '0.0.0.0', false);

            return { ok: true, url: inspector.url() || null, alreadyOpen: false };
        } catch (error) {
            return { ok: false, error: `Could not open the inspector: ${error.message}` };
        }
    };

    return { evaluate, openInspector, names };
};

module.exports = { createRepl, MAX_OUTPUT, DEPTH };
