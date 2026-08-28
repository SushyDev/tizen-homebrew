'use strict';

// A router, in about sixty lines.
//
// This replaces express, which was 484KB of the bundle — by far its largest
// single dependency — for method matching, one static directory and a raw
// body. Those three things are what follows.

const { json, failure } = require('./respond.js');
const { size, took, host } = require('../obs/units.js');

/**
 * Builds a router.
 *
 * Routes are matched in the order they were added, so a catch-all added last
 * behaves as a fallback. Paths may end in `/*` to match a prefix, which is all
 * the pattern matching this service has ever needed.
 *
 * `log` gets one line per request, in the order an access log has printed
 * them since NCSA httpd: who asked, what they asked for, what they got, how
 * big it was and how long it took. `quiet(request, path)` marks the requests
 * that are not events — see the note on it in main.js.
 */
const createRouter = (options) => {
    const settings = options || {};
    const log = settings.log || null;
    const quiet = settings.quiet || (() => false);

    const routes = [];

    const add = (method, path, handle) => {
        const isPrefix = path.endsWith('/*');
        const prefix = isPrefix ? path.slice(0, -1) : null;

        const matches = (requestMethod, requestPath) => {
            if (requestMethod !== method) return false;
            return isPrefix ? requestPath.startsWith(prefix) : requestPath === path;
        };

        routes.push({ matches, handle });
    };

    const on = {
        get: (path, handle) => add('GET', path, handle),
        post: (path, handle) => add('POST', path, handle),
        delete: (path, handle) => add('DELETE', path, handle)
    };

    /**
     * The listener handed to `http.createServer`.
     *
     * A handler may return a promise; rejecting it produces a 500 rather than
     * an unhandled rejection that takes the service down.
     */
    const listener = (request, response) => {
        // Timed from the moment the head arrives rather than from the handler,
        // so an upload's own transfer is inside the number a person reads.
        const startedAt = Date.now();

        if (log) {
            response.on('finish', () => {
                const status = response.statusCode;
                const sent = Number(response.getHeader('content-length')) || 0;
                const path = request.url.split('?')[0];

                const level = quiet(request, path) ? 'debug'
                    : status >= 500 ? 'err'
                        : status >= 400 ? 'warn'
                            : 'info';

                log[level]('http', `${host(request.socket && request.socket.remoteAddress)} ` +
                    `${request.method} ${path} ${status} ${size(sent)} ${took(Date.now() - startedAt)}`);
            });
        }

        // Browsers preflight the phone UI's cross-origin calls.
        if (request.method === 'OPTIONS') {
            response.writeHead(204, {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
                'access-control-allow-headers': '*'
            });
            return response.end();
        }

        const path = request.url.split('?')[0];
        const route = routes.find((candidate) => candidate.matches(request.method, path));

        if (!route) return failure(response, 404, 'notFound', `No route for ${request.method} ${path}`);

        const query = new URLSearchParams(request.url.split('?')[1] || '');

        Promise.resolve()
            .then(() => route.handle(request, response, { path, query }))
            .catch((error) => {
                console.error(`${request.method} ${path} failed:`, error && error.stack ? error.stack : error);
                if (!response.headersSent) {
                    failure(response, 500, error && error.code ? error.code : 'internal', String(error && error.message || error));
                }
            });
    };

    return { on, listener, json, failure };
};

module.exports = { createRouter };
