'use strict';

// The HTTP client, and the one property of it that cannot be seen from a desk.
//
// lwnode gives any ClientRequest without a timeout a hidden fifteen-second
// socket timeout and calls destroy() on it, so a slow download surfaces as
// ECONNRESET with no deadline named. Mainline Node has no such default, which
// means the protection is invisible here unless it is asserted structurally:
// every request must carry `timeout` in its options.

const http = require('http');

const fetch = require('../src/remote/fetch.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

// Every options object the client hands to http.request, in order.
const asked = [];
const realRequest = http.request;

http.request = function (target, options, callback) {
    asked.push(options);
    return realRequest.call(this, target, options, callback);
};

const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const main = async () => {
    {
        const { server, port } = await listen((request, response) => response.end('{"ok":true}'));

        await fetch.getJson(`http://127.0.0.1:${port}/`);

        check('a request carries its timeout in the options, not only on the socket',
            asked.length === 1 && asked[0].timeout === fetch.DEFAULT_TIMEOUT,
            JSON.stringify(asked[0]));

        asked.length = 0;
        await fetch.request(`http://127.0.0.1:${port}/`, { timeout: 4321 });

        check('a caller-supplied timeout is the one that travels',
            asked[0].timeout === 4321, JSON.stringify(asked[0]));

        server.close();
    }

    {
        // A redirect starts a second request, and it must not lose the deadline.
        const { server, port } = await listen((request, response) => {
            if (request.url === '/from') {
                response.writeHead(302, { location: `http://127.0.0.1:${port}/to` });
                return response.end();
            }
            response.end('done');
        });

        asked.length = 0;
        await fetch.request(`http://127.0.0.1:${port}/from`, { timeout: 5555 });

        check('a redirect carries the timeout to the next request',
            asked.length === 2 && asked.every((options) => options.timeout === 5555),
            JSON.stringify(asked));

        server.close();
    }

    {
        // Accepted and then never answered: the deadline is the only thing that
        // ends this, and it has to end it as a deadline.
        const held = [];
        const { server, port } = await listen((request) => held.push(request));

        const began = Date.now();
        const error = await fetch.request(`http://127.0.0.1:${port}/`, { timeout: 300 })
            .then(() => null, (failure) => failure);
        const elapsed = Date.now() - began;

        check('a server that never answers fails as a timeout, in the time given',
            error && /Timed out after 300ms/.test(error.message) && elapsed >= 300 && elapsed < 3000,
            `${error && error.message} after ${elapsed}ms`);

        server.close();
        held.forEach((request) => request.destroy());
    }

    http.request = realRequest;

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
