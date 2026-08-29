'use strict';

const MAX_BODY = 200 * 1024 * 1024;

// CORS is open because the phone UI is a separate origin.
const json = (response, value, status = 200) => {
    const payload = JSON.stringify(value);

    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'access-control-allow-origin': '*'
    });
    response.end(payload);
};

const failure = (response, status, code, message, remedy) =>
    json(response, remedy
        ? { ok: false, code, message, remedy }
        : { ok: false, code, message }, status);

const bytes = (response, buffer, contentType) => {
    response.writeHead(200, {
        'content-type': contentType,
        'content-length': buffer.length,
        'access-control-allow-origin': '*'
    });
    response.end(buffer);
};

// The cap matters: this accepts uploaded packages, and without one a request could exhaust the TV.
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
