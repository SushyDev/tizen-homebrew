'use strict';

// The smallest HTTP client that does everything Tizen Homebrew needs.
//
// This replaces node-fetch, which cost 308KB of the bundle — most of a
// Fetch/Headers/Response implementation we barely touched. Node 12 has no
// global fetch, so something has to fill the gap; this is that something, and
// it is about a hundred lines.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 15000;

// GitHub serves release assets as a redirect to object storage, so following
// them is not optional. The cap is only there to stop a redirect loop.
const MAX_REDIRECTS = 5;

/**
 * Performs one HTTP request and buffers the reply.
 *
 * Resolves with `{ status, headers, body }` for any completed response,
 * including 4xx and 5xx — a server saying "no" is an answer, not a failure.
 * Rejects only when no answer arrives at all.
 */
const request = (url, options = {}) => {
    const { method = 'GET', headers = {}, body, timeout = DEFAULT_TIMEOUT, redirectsLeft = MAX_REDIRECTS } = options;

    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === 'https:' ? https : http;

        const failWith = (message) => reject(Object.assign(new Error(message), { url }));

        const collect = (response) => {
            const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && response.headers.location;

            if (isRedirect) {
                response.resume(); // Drain, or the socket is held open.

                if (redirectsLeft <= 0) return failWith(`Too many redirects from ${url}`);

                const next = new URL(response.headers.location, url).toString();
                return resolve(request(next, { ...options, redirectsLeft: redirectsLeft - 1 }));
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks)
            }));
            response.on('error', (error) => failWith(`Response failed: ${error.message}`));
        };

        const outgoing = transport.request(target, { method, headers }, collect);

        outgoing.setTimeout(timeout, () => {
            outgoing.destroy();
            failWith(`Timed out after ${timeout}ms: ${url}`);
        });

        outgoing.on('error', (error) => failWith(`${error.code || 'Request failed'}: ${url}`));

        if (body) outgoing.write(body);
        outgoing.end();
    });
};

/** Fetches and parses JSON, rejecting on a non-2xx status or unparseable body. */
const getJson = async (url, options = {}) => {
    const { status, body } = await request(url, options);

    if (status < 200 || status >= 300) {
        throw Object.assign(new Error(`${url} returned ${status}`), { status });
    }

    try {
        return JSON.parse(body.toString('utf8'));
    } catch (e) {
        throw new Error(`${url} did not return JSON`);
    }
};

/** Fetches raw bytes, rejecting on a non-2xx status. */
const getBuffer = async (url, options = {}) => {
    const { status, body } = await request(url, options);

    if (status < 200 || status >= 300) {
        throw Object.assign(new Error(`${url} returned ${status}`), { status });
    }

    return body;
};

module.exports = { request, getJson, getBuffer, MAX_REDIRECTS };
