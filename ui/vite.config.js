import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import presetEnv from 'postcss-preset-env';

import { gridGap } from '../tools/postcss-grid-gap.mjs';
import { devService } from './dev/service.js';

// The TV to develop against. With HOMEBREW_TV set, `npm run dev` proxies
// every API call and the WebSocket to a real device, so the UI can be edited
// with hot reload while talking to actual hardware — no mocks, and no
// reinstalling to see a change.
//
// Without it, dev/service.js answers instead. That is the difference between
// a design that can be looked at on any laptop and one that can only be
// looked at by someone holding the television.
const TV = process.env.HOMEBREW_TV || '';
const SERVICE = TV ? `http://${TV}:8091` : '';

// Everything the service owns. Anything not listed here is a UI asset.
const API = ['/pin', '/state', '/version', '/health', '/logs', '/packages', '/install', '/restart'];

// Which page this invocation builds. vite-plugin-singlefile inlines
// everything into one file, which rules out code splitting and therefore
// multiple inputs — so each page is built in its own pass. See build.js.
const PAGE = process.env.HOMEBREW_PAGE || 'index';

// The oldest engine that has to render this.
//
// Tizen 5.5 ships Chromium 63 and Tizen 6.5 ships Chromium 76 — both far
// behind anything a phone runs, and both fail *silently*: an unknown at-rule
// takes the whole stylesheet with it, an unknown selector takes its rule, and
// the page renders as unstyled text with no console error to find. That is
// exactly how the previous stylesheet disappeared on the TV.
//
// So the source is written in modern CSS and PostCSS lowers it to what these
// engines actually parse, and `build.js` refuses to ship output containing
// anything they would drop. The rule is enforced, not remembered.
const ENGINE = 'chrome >= 63';

export default defineConfig({
    css: {
        postcss: {
            plugins: [presetEnv({
                browsers: ENGINE,
                features: {
                    // Structure. These are what let the stylesheet be written
                    // as one readable document instead of a flat list, and
                    // all three lower to plain CSS exactly.
                    'nesting-rules': true,
                    'custom-media-queries': true,
                    'custom-selectors': true,

                    // Syntax. Space-separated colours and `#rrggbbaa` are
                    // simply nicer to write and lower to rgba() with nothing
                    // lost; `:is()` and multi-argument `:not()` expand into
                    // the selector lists they stand for.
                    'color-functional-notation': true,
                    'hexadecimal-alpha-notation': true,
                    'is-pseudo-class': true,
                    'not-pseudo-class': true,
                    'media-query-ranges': true,
                    'double-position-gradients': true,

                    // Chromium 63 already has custom properties, so inlining
                    // fallbacks would only make the file bigger — and the
                    // theme depends on them staying live.
                    'custom-properties': false,

                    // These two need a JavaScript polyfill to mean anything,
                    // and shipping one to a television to style a focus ring
                    // is not a trade worth making.
                    'focus-visible-pseudo-class': false,
                    'focus-within-pseudo-class': false
                }
            }),

            // `gap` is `grid-gap` until Chromium 66. Deliberately not
            // preset-env's own `gap-properties`, which ignores
            // `display: inline-grid` — and every button in this interface is
            // one, so that omission covered precisely the controls a person
            // touches. Runs after preset-env so it sees the flat rules
            // nesting produced rather than the nested source.
            gridGap()]
        }
    },

    plugins: [
        // One file, no separate .js or .css: fewer zip entries in the .wgt,
        // and nothing to go missing when the service serves it.
        viteSingleFile(),

        // Development only, and only when there is no TV to talk to.
        devService({ enabled: !TV })
    ],

    build: {
        outDir: 'dist',
        // Each pass writes one page, so only the first may clear the folder.
        emptyOutDir: PAGE === 'index',
        rollupOptions: { input: `${PAGE}.html` },
        target: 'chrome63',
        cssTarget: 'chrome63',
        cssMinify: true,
        reportCompressedSize: true,

        // The theme is a megabyte of lossless audio and must stay a separate
        // file. Inlined as a data: URI it would triple the page and have to
        // be parsed before anything rendered.
        assetsInlineLimit: 0
    },

    server: {
        host: true,
        proxy: TV ? {
            ...Object.fromEntries(API.map((path) => [path, { target: SERVICE, changeOrigin: true }])),
            // The socket carries install progress and relay output.
            '/socket': { target: SERVICE.replace('http', 'ws'), ws: true, rewrite: () => '/' }
        } : undefined
    }
});
