'use strict';

// Turning a value into an HTTP reply, and a request into a body.
//
// Every handler in this service answers with JSON, so that is the only shape
// worth having a helper for. Nothing here knows what Tizen Homebrew does; it only
// knows how to finish a response.

const MAX_BODY = 200 * 1024 * 1024;

/** Sends `value` as JSON. CORS is open because the phone UI is a separate origin. */
const json = (response, value, status = 200) => {
    const payload = JSON.stringify(value);

    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'access-control-allow-origin': '*'
    });
    response.end(payload);
};

/**
 * Sends an error in the shape every client already expects: `{ ok, code,
 * message }`. Keeping one shape means the UI never has to guess whether a
 * failure came from the socket or from HTTP.
 */
const failure = (response, status, code, message) =>
    json(response, { ok: false, code, message }, status);

/** Sends a file's bytes, with the content type the caller worked out. */
const bytes = (response, buffer, contentType) => {
    response.writeHead(200, {
        'content-type': contentType,
        'content-length': buffer.length,
        'access-control-allow-origin': '*'
    });
    response.end(buffer);
};

/**
 * Buffers a request body, refusing anything implausible.
 *
 * The cap matters: this endpoint accepts uploaded packages, so without a limit
 * a single request could exhaust the TV's memory.
 */
const readBody = (request, limit = MAX_BODY) => new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    const stop = (message) => {
        request.destroy();
        reject(new Error(message));
    };

    request.on('data', (chunk) => {
        received += chunk.length;
        if (received > limit) return stop(`Body exceeded ${limit} bytes`);
        chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', (error) => reject(error));
});

module.exports = { json, failure, bytes, readBody, MAX_BODY };
