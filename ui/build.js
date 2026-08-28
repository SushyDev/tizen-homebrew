// Building both pages, then proving they will render on the television.
//
// The phone UI and the TV screen share a design system but are separate
// documents, and each is inlined into a single file — which rules out code
// splitting, and so rules out building them in one pass. Two passes it is.
//
// The third pass is the one that matters: the build reads its own output back
// and refuses to ship CSS the TV would drop. See check.js for why that is not
// paranoia.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { build } from 'vite';
import { unsupportedCss, stylesOf } from '../tools/css-support.js';

const PAGES = ['index', 'tv'];

for (const page of PAGES) {
    process.env.HOMEBREW_PAGE = page;
    await build();
}

const complaints = readdirSync('dist')
    .filter((name) => name.endsWith('.html'))
    .flatMap((name) => unsupportedCss(stylesOf(readFileSync(join('dist', name), 'utf8')))
        .map((problem) => `  ${name}: ${problem}`));

if (complaints.length > 0) {
    console.error([
        '',
        'This CSS would not render on the television.',
        '',
        ...complaints,
        '',
        'Tizen 6.5 is Chromium 76 and drops what it cannot parse without a word.',
        'Either write it another way, or teach PostCSS to lower it in vite.config.js.',
        ''
    ].join('\n'));

    process.exit(1);
}

console.log(`\nchecked ${PAGES.length} pages against Chromium 63 — nothing the TV would drop\n`);
