'use strict';

// Verifies the built bundle only uses syntax — and core modules — the target
// runtime has.
//
// The floor is Node 12.16.3, which is what Tizen 6.0 through 8.0 run and what
// was measured on a 6.5 set. Tizen 9.0 and 10.0 moved to 18.18.2, verified on
// a 9.0 set; older than 6.0 is lwnode rather than mainline Node. The full
// mapping lives in tools/matrix.js, next to the versions it selects.
//
// What Node 12 lacks is optional chaining, nullish coalescing and logical
// assignment, all of which arrived in Node 14. Grepping cannot tell those
// apart from string contents, so this walks the AST instead.
//
// Modules are checked here too, because syntax was not the whole floor and
// finding that out cost an evening. `require('fs/promises')` parses perfectly
// on every version of everything; it simply does not resolve before Node 14.
// The bundle built, passed this check, installed, launched — and the service
// died on its first require with the port never opening and no log to say so,
// because nothing had started that could write one.
//
// This is checked rather than trusted because the bundler is asked to
// downlevel: if that ever silently stops happening, the failure would
// otherwise appear only on the TV.
//
// Regular expressions are checked too. There is nothing to lower `(?<=\n)` to,
// so the bundler emits it as written and lwnode raises SyntaxError over the
// whole file. See tools/js-support.js.

const acorn = require('acorn');
const { readFileSync } = require('fs');

const { unsupportedJs } = require('../tools/js-support.js');

const UNSUPPORTED = {
    ChainExpression: 'optional chaining (?.)',
    LogicalAssignmentExpression: 'logical assignment (||= &&= ??=)'
};

// Nullish coalescing is a LogicalExpression with a distinctive operator.
const UNSUPPORTED_OPERATORS = { '??': 'nullish coalescing (??)' };

// Core modules whose slashed form arrived after the floor. The submodule is
// what is missing, not the parent: `fs` is fine and `fs.promises` is fine, so
// the fix is always to reach through the parent rather than to stop using the
// API.
const UNSUPPORTED_MODULES = [
    'fs/promises', 'dns/promises', 'stream/promises',
    'timers/promises', 'readline/promises', 'stream/consumers', 'stream/web'
];

function check(file) {
    const source = readFileSync(file, 'utf8');
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script', locations: true });
    } catch (e) {
        console.error(`${file}: could not be parsed at all — ${e.message}`);
        return 1;
    }

    const findings = [];

    (function walk(node) {
        if (!node || typeof node.type !== 'string') return;

        const label = UNSUPPORTED[node.type];
        if (label) findings.push({ label, line: node.loc.start.line });

        if (node.type === 'LogicalExpression' && UNSUPPORTED_OPERATORS[node.operator]) {
            findings.push({ label: UNSUPPORTED_OPERATORS[node.operator], line: node.loc.start.line });
        }
        if (node.type === 'AssignmentExpression' && ['||=', '&&=', '??='].includes(node.operator)) {
            findings.push({ label: 'logical assignment', line: node.loc.start.line });
        }

        if (node.type === 'CallExpression' &&
            node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
            node.arguments.length && node.arguments[0].type === 'Literal' &&
            UNSUPPORTED_MODULES.indexOf(node.arguments[0].value) !== -1) {
            findings.push({
                label: `require('${node.arguments[0].value}') — not resolvable before Node 14`,
                line: node.loc.start.line
            });
        }

        for (const key in node) {
            if (key === 'loc' || key === 'type') continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value.type === 'string') walk(value);
        }
    })(ast);

    // Reported apart from the findings above: Node 12 is measured on a set,
    // Escargot is the engine a set might turn out to be running.
    const expressions = unsupportedJs(source, 'escargot');

    if (!findings.length && !expressions.length) {
        console.log(`${file}: clean — parses and resolves on Node 12 (Tizen 6.5), and on Escargot.`);
        return 0;
    }

    if (findings.length) {
        const byLabel = {};
        findings.forEach((f) => {
            if (!byLabel[f.label]) byLabel[f.label] = [];
            byLabel[f.label].push(f.line);
        });

        console.error(`${file}: ${findings.length} construct(s) Node 12 cannot run:`);
        for (const label in byLabel) {
            const lines = byLabel[label];
            console.error(`  ${label} x${lines.length}  (first at line ${lines[0]})`);
        }
    }

    if (expressions.length) {
        console.error(`${file}: ${expressions.length} regular expression(s) lwnode cannot parse:`);
        expressions.forEach((problem) => console.error(`  ${problem}`));
        console.error('  A television running lwnode raises SyntaxError over the whole bundle,');
        console.error('  so the service dies before it can open its port or write a log line.');
    }

    return 1;
}

process.exit(check(process.argv[2] || 'dist/index.js'));
