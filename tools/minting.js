'use strict';

// Talking to Samsung, without the command around it. `mint` is the CLI; the standalone installer
// runs the same two steps between a discovery menu and an install.
//
// The sign-in lives here rather than in the sdk because it needs a browser and a port; everything
// past the access token is protocol, and that is `sdk/samsung.js`.

const { createServer } = require('http');
const { writeFileSync, copyFileSync, mkdirSync } = require('fs');
const { join, dirname, resolve } = require('path');

const samsung = require('../sdk/samsung.js');

// The port registered in the redirect_uri Samsung sends the browser back to.
const CALLBACK_PORT = 4794;
const CALLBACK = `http://localhost:${CALLBACK_PORT}/signin/callback`;

const SIGN_IN = 'https://account.samsung.com/mobile/account/check.do' +
    `?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=${CALLBACK}`;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

// The answer arrives as a form POST whose `code` field is a JSON document, whatever the field is called.
const signIn = () => new Promise((resolve_, reject) => {
    const server = createServer((request, response) => {
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));

        request.on('end', () => {
            const answer = (() => {
                try {
                    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
                    return JSON.parse(form.get('code'));
                } catch (e) {
                    return null;
                }
            })();

            const done = answer && answer.access_token && answer.userId;

            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(done
                ? '<h2>Signed in.</h2><p>Close this and go back to the terminal.</p>'
                : '<h2>That did not carry a token.</h2><p>Check the terminal.</p>');

            if (request.method === 'GET') return;

            server.close();

            if (!done) {
                return reject(friendly('Samsung sent the browser back without an access token.'));
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
    const author = keeping ? null : await samsung.authorPair(account, {
        name: authorInfo.name,
        password: authorInfo.password
    });

    const distributor = await samsung.distributorPair(account, {
        email: authorInfo.email,
        password: authorInfo.password,
        level: authorInfo.privilegeLevel,
        devices
    });

    return {
        authorCert: author && author.p12,
        distributorCert: distributor.p12,
        distributorXML: distributor.profile,
        profileFrom: distributor.profileFrom,
        devices
    };
};

// A kept author lives beside the pair it came with, so an output elsewhere takes a copy and stands alone.
const write = (directory, minted, keeping, password, existing) => {
    mkdirSync(directory, { recursive: true });

    writeFileSync(join(directory, 'distributor.p12'), minted.distributorCert);
    writeFileSync(join(directory, 'device-profile.xml'), minted.distributorXML);

    if (!keeping) {
        writeFileSync(join(directory, 'author.p12'), minted.authorCert);
        writeFileSync(join(directory, 'author.pw'), password);
        return;
    }

    if (resolve(dirname(existing.author)) === resolve(directory)) return;

    copyFileSync(existing.author, join(directory, 'author.p12'));
    writeFileSync(join(directory, 'author.pw'), existing.password);
};

module.exports = { signIn, mint, write, SIGN_IN, CALLBACK_PORT };
