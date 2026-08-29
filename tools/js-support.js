'use strict';

const acorn = require('acorn');

// Bundlers leave regexes alone, so an unsupported one is a SyntaxError over the whole bundle.
const FEATURES = [
    {
        name: 'lookbehind ((?<= or (?<!)',
        chromium: 62,
        escargot: false,
        test: (pattern) => /\(\?<[=!]/.test(pattern)
    },
    {
        name: 'a named capture group ((?<name>)',
        chromium: 64,
        escargot: false,
        test: (pattern) => /\(\?<[A-Za-z_$][A-Za-z0-9_$]*>/.test(pattern)
    },
    {
        name: 'a named backreference (\\k<name>)',
        chromium: 64,
        escargot: false,
        test: (pattern) => /\\k<[A-Za-z_$][A-Za-z0-9_$]*>/.test(pattern)
    },
    {
        name: 'a Unicode property escape (\\p{...})',
        chromium: 64,
        escargot: null,
        test: (pattern, flags) => /\\[pP]\{/.test(pattern) && flags.indexOf('u') !== -1
    }
];

const patternProblems = (pattern, flags, floor) => FEATURES
    .filter((feature) => (floor === 'chromium'
        ? feature.chromium !== null && feature.chromium > 63
        : feature.escargot === false))
    .filter((feature) => feature.test(String(pattern), String(flags || '')))
    .map((feature) => (floor === 'chromium'
        ? `${feature.name} — Chromium ${feature.chromium}`
        : `${feature.name} — absent from Escargot, so lwnode cannot parse the file`));

const expressionsIn = (source) => {
    const parse = (sourceType) => acorn.parse(source, { ecmaVersion: 2022, sourceType, locations: true });

    let ast;
    try {
        ast = parse('module');
    } catch (e) {
        ast = parse('script');
    }

    const found = [];

    const named = (node) => node && node.type === 'Identifier' && node.name === 'RegExp';
    const text = (node) => (node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null);

    (function walk(node) {
        if (!node || typeof node.type !== 'string') return;

        if (node.type === 'Literal' && node.regex) {
            found.push({ pattern: node.regex.pattern, flags: node.regex.flags, line: node.loc.start.line });
        }

        if ((node.type === 'NewExpression' || node.type === 'CallExpression') && named(node.callee)) {
            const pattern = text(node.arguments[0]);
            if (pattern !== null) {
                found.push({ pattern, flags: text(node.arguments[1]) || '', line: node.loc.start.line });
            }
        }

        for (const key in node) {
            if (key === 'loc' || key === 'type') continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value.type === 'string') walk(value);
        }
    })(ast);

    return found;
};

const unsupportedJs = (source, floor) => {
    const problems = expressionsIn(source).flatMap(({ pattern, flags, line }) => patternProblems(pattern, flags, floor)
        .map((problem) => `${problem}  (/${pattern}/${flags} at line ${line})`));

    return [...new Set(problems)];
};

const scriptsOf = (html) => (html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || [])
    .map((tag) => tag.replace(/^<script\b[^>]*>/, '').replace(/<\/script>$/, ''))
    .filter((body) => body.trim());

module.exports = { unsupportedJs, scriptsOf, patternProblems, expressionsIn, FEATURES };
