'use strict';

const acorn = require('acorn');
const { readFileSync } = require('fs');

const { unsupportedJs } = require('../tools/js-support.js');

// The service bundle has to parse on Node 12, which is what the oldest televisions run.
const UNSUPPORTED = {
    ChainExpression: 'optional chaining (?.)',
    LogicalAssignmentExpression: 'logical assignment (||= &&= ??=)'
};

const UNSUPPORTED_OPERATORS = { '??': 'nullish coalescing (??)' };

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
