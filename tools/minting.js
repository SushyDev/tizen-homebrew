'use strict';

// Talking to Samsung, without the command around it. `mint` is the CLI; the standalone installer
// runs the same two steps between a discovery menu and an install.
//
// `tizenjs create-samsung-cert` cannot do this today — it reads Samsung's authorization code as an
// access token — so this serves the sign-in redirect on localhost and calls the creator directly.

const { createServer } = require('http');
const { writeFileSync, copyFileSync, mkdirSync } = require('fs');
const { join, dirname, resolve } = require('path');

// The port registered in the redirect_uri Samsung sends the browser back to.
const CALLBACK_PORT = 4794;
const CALLBACK = `http://localhost:${CALLBACK_PORT}/signin/callback`;

// The value Apps2Samsung sends, which Samsung is known to hand back untouched.
const STATE = 'accountcheckdogeneratedstatetext';

// signInGate directly, because `check.do` can drop the request after login and leave the browser on the account page.
const SIGN_IN = 'https://account.samsung.com/accounts/be1dce529476c1a6d407c4c7578c31bd/signInGate' +
    `?locale=&clientId=v285zxnl3h&redirect_uri=${encodeURIComponent(CALLBACK)}&state=${STATE}&tokenType=TOKEN`;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

// The answer's `code` is a JSON document, POSTed as a form by most accounts and put in the query by some.
const fieldIn = (name, body, url) => {
    // Split the raw body before decoding, so a `+` or `=` inside the token survives.
    for (const pair of body.split('&')) {
        const eq = pair.indexOf('=');

        if (eq !== -1 && pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
    }

    return new URL(url, CALLBACK).searchParams.get(name);
};

const signIn = () => new Promise((resolve_, reject) => {
    const server = createServer((request, response) => {
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));

        request.on('end', () => {
            if (new URL(request.url, CALLBACK).pathname !== '/signin/callback') {
                response.writeHead(404);
                return response.end();
            }

            const body = Buffer.concat(chunks).toString('utf8');

            const answer = (() => {
                try {
                    if (fieldIn('state', body, request.url) !== STATE) return null;

                    return JSON.parse(fieldIn('code', body, request.url));
                } catch (e) {
                    return null;
                }
            })();

            const done = answer && answer.access_token && answer.userId;

            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(done
                ? '<h2>Signed in.</h2><p>Close this and go back to the terminal.</p>'
                : '<h2>That did not carry a token.</h2><p>Check the terminal.</p>');

            server.close();

            if (!done) {
                // Only the field names, so the error can be pasted without leaking anything.
                const fields = [...new URLSearchParams(body).keys(),
                    ...new URL(request.url, CALLBACK).searchParams.keys()];

                return reject(friendly(
                    `Samsung sent the browser back without an access token (${request.method}, fields: ${fields.join(', ') || 'none'}).`
                ));
            }

            resolve_({ accessToken: answer.access_token, userId: answer.userId, email: answer.inputEmailID });
        });
    });

    server.on('error', (error) => reject(friendly(
        `Could not listen on ${CALLBACK_PORT} for the sign-in: ${error.message}`
    )));

    server.listen(CALLBACK_PORT, '127.0.0.1');
});

// One distributor certificate names several devices, so a second set adds to the list; the author
// certificate is kept where there is one, because Tizen refuses to update across a changed one and
// recovering needs sdb.
const mint = async (account, authorInfo, devices, keeping) => {
    const { SamsungCertificateCreator } = require('tizen');
    const creator = new SamsungCertificateCreator();

    // Only the distributor names devices, and the two certificates are independent.
    const distributorOnly = async () => {
        await creator._downloadVDCertificates();

        const request = creator._generateDistributorCert(authorInfo, devices);

        const profile = await creator._fetchDistributorCert(account, authorInfo, request);
        const issued = await creator._fetchDistributorCert(account, authorInfo, request);

        return {
            distributorCert: await creator._generateDistributorPKCS12(request, issued, authorInfo),
            distributorXML: profile
        };
    };

    return (keeping ? distributorOnly() : creator.createCertificate(authorInfo, account, devices))
        .catch((error) => {
            throw friendly(`Samsung refused to issue the certificate:\n\n  ${error.message}`);
        });
};

// A kept author lives beside the pair it came with, so an output elsewhere takes a copy and stands alone.
const write = (directory, minted, keeping, password, existing) => {
    mkdirSync(directory, { recursive: true });

    writeFileSync(join(directory, 'distributor.p12'), Buffer.from(minted.distributorCert, 'binary'));
    writeFileSync(join(directory, 'device-profile.xml'), minted.distributorXML);

    if (!keeping) {
        writeFileSync(join(directory, 'author.p12'), Buffer.from(minted.authorCert, 'binary'));
        writeFileSync(join(directory, 'author.pw'), password);
        return;
    }

    if (resolve(dirname(existing.author)) === resolve(directory)) return;

    copyFileSync(existing.author, join(directory, 'author.p12'));
    writeFileSync(join(directory, 'author.pw'), existing.password);
};

module.exports = { signIn, mint, write, SIGN_IN, CALLBACK_PORT };
