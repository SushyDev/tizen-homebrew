import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { build } from 'vite';
import { unsupportedCss, stylesOf } from '../tools/css-support.js';
import { unsupportedJs, scriptsOf } from '../tools/js-support.js';

// Each page is inlined into a single file, which rules out code splitting and so rules out
// building both in one pass. The third pass reads the output back and refuses CSS the TV would drop.
const PAGES = ['index', 'tv'];

for (const page of PAGES) {
    process.env.HOMEBREW_PAGE = page;
    await build();
}

const pages = readdirSync('dist')
    .filter((name) => name.endsWith('.html'))
    .map((name) => ({ name, html: readFileSync(join('dist', name), 'utf8') }));

const cssComplaints = pages
    .flatMap(({ name, html }) => unsupportedCss(stylesOf(html)).map((problem) => `  ${name}: ${problem}`));

const jsComplaints = pages
    .flatMap(({ name, html }) => scriptsOf(html)
        .flatMap((script) => unsupportedJs(script, 'chromium').map((problem) => `  ${name}: ${problem}`)));

const refuse = (heading, complaints, advice) => {
    console.error(['', heading, '', ...complaints, '', ...advice, ''].join('\n'));
    process.exit(1);
};

if (cssComplaints.length > 0) {
    refuse('This CSS would not render on the television.', cssComplaints, [
        'Tizen 6.5 is Chromium 76 and drops what it cannot parse without a word.',
        'Either write it another way, or teach PostCSS to lower it in vite.config.js.'
    ]);
}

if (jsComplaints.length > 0) {
    refuse('This JavaScript would not parse on the television.', jsComplaints, [
        'Tizen 5.5 is Chromium 63, and an unsupported regular expression is a',
        'SyntaxError over the whole inlined script — the page renders as nothing.',
        'Rewrite the expression; there is no build step that can lower it.'
    ]);
}

console.log(`\nchecked ${PAGES.length} pages against Chromium 63 — no CSS it would drop, no regex it would refuse\n`);
