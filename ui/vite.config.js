import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import presetEnv from 'postcss-preset-env';

import { gridGap } from '../tools/postcss-grid-gap.mjs';
import { devService } from './dev/service.js';

// With HOMEBREW_TV set, `npm run dev` proxies every API call and the WebSocket to a real device;
// without it, dev/service.js answers instead.
const TV = process.env.HOMEBREW_TV || '';
const SERVICE = TV ? `http://${TV}:8091` : '';

const API = ['/pin', '/state', '/version', '/health', '/logs', '/packages', '/install', '/restart', '/shutdown'];

const PAGE = process.env.HOMEBREW_PAGE || 'index';

// Tizen 5.5 ships Chromium 63 and Tizen 6.5 ships Chromium 76, and both fail silently: an unknown
// at-rule takes the whole stylesheet with it, with no console error to find. So the source is
// modern CSS, PostCSS lowers it, and build.js refuses output containing anything they would drop.
const ENGINE = 'chrome >= 63';

export default defineConfig({
    css: {
        postcss: {
            plugins: [presetEnv({
                browsers: ENGINE,
                features: {
                    'nesting-rules': true,
                    'custom-media-queries': true,
                    'custom-selectors': true,

                    'color-functional-notation': true,
                    'hexadecimal-alpha-notation': true,
                    'is-pseudo-class': true,
                    'not-pseudo-class': true,
                    'media-query-ranges': true,
                    'double-position-gradients': true,

                    'custom-properties': false,

                    'focus-visible-pseudo-class': false,
                    'focus-within-pseudo-class': false
                }
            }),

            gridGap()]
        }
    },

    plugins: [
        viteSingleFile(),

        devService({ enabled: !TV })
    ],

    build: {
        outDir: 'dist',
        emptyOutDir: PAGE === 'index',
        rollupOptions: { input: `${PAGE}.html` },
        target: 'chrome63',
        cssTarget: 'chrome63',
        cssMinify: true,
        reportCompressedSize: true,

        assetsInlineLimit: 0
    },

    server: {
        host: true,
        proxy: TV ? {
            ...Object.fromEntries(API.map((path) => [path, { target: SERVICE, changeOrigin: true }])),
            '/socket': { target: SERVICE.replace('http', 'ws'), ws: true, rewrite: () => '/' }
        } : undefined
    }
});
