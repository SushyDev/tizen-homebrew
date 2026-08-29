'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 15000;

const MAX_REDIRECTS = 5;

// A hundred lines in place of node-fetch, which cost 308KB of the bundle. Node 12 has no global fetch.
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

        const outgoing = transport.request(target, { method, headers, timeout }, collect);

        outgoing.setTimeout(timeout, () => {
            outgoing.destroy();
            failWith(`Timed out after ${timeout}ms: ${url}`);
        });

        outgoing.on('error', (error) => failWith(`${error.code || 'Request failed'}: ${url}`));

        if (body) outgoing.write(body);
        outgoing.end();
    });
};

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

const getBuffer = async (url, options = {}) => {
    const { status, body } = await request(url, options);

    if (status < 200 || status >= 300) {
        throw Object.assign(new Error(`${url} returned ${status}`), { status });
    }

    return body;
};

module.exports = { request, getJson, getBuffer, MAX_REDIRECTS, DEFAULT_TIMEOUT };
