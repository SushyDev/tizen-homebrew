'use strict';

// Minting a certificate pair for one television.
//
//   npm run mint -- 192.168.2.9 <pin>     asks the TV which device it is
//   npm run mint -- --duid BDCPQZFMHIZII  when you already know
//
// Samsung binds a signing certificate to a device id, and issues it only to a
// signed-in Samsung account. `tizenjs create-samsung-cert` does this too, and
// currently cannot: it sends you to a sign-in gate that answers with an
// authorization *code*, then reads that answer as though it contained an
// access token —
//
//     accessInfo = { accessToken: accessInfo.access_token, userId: accessInfo.userId }
//
// — so both fields come out undefined and Samsung replies "Either userid or
// accesstoken is incorrect", which sounds like a problem with the account.
//
// The sign-in that still hands back a token is the one TizenBrew Installer
// uses: `check.do` with `actionID=StartOAuth2&accessToken=Y`, which POSTs the
// answer to a redirect_uri as a form field whose value is JSON. So this serves
// that redirect on localhost, waits for the browser to arrive, and calls the
// certificate creator directly.

const { createServer } = require('http');
const { writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const certificates = require('./certificates.js');
const { duidOf } = require('./tv.js');

// The port is not arbitrary: it is the one registered in the redirect_uri that
// Samsung's sign-in will send the browser back to.
const CALLBACK_PORT = 4794;
const CALLBACK = `http://localhost:${CALLBACK_PORT}/signin/callback`;

const SIGN_IN = 'https://account.samsung.com/mobile/account/check.do' +
    `?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=${CALLBACK}`;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

/**
 * Waits for the browser to come back from Samsung with an access token.
 *
 * The answer arrives as a form POST whose `code` field is a JSON document —
 * not an authorization code, whatever the field is called — carrying the
 * access token, the user id and the address that signed in.
 */
const signIn = () => new Promise((resolve, reject) => {
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

            resolve({ accessToken: answer.access_token, userId: answer.userId, email: answer.inputEmailID });
        });
    });

    server.on('error', (error) => reject(friendly(
        `Could not listen on ${CALLBACK_PORT} for the sign-in: ${error.message}`
    )));

    server.listen(CALLBACK_PORT, '127.0.0.1');
});

const main = async () => {
    const args = process.argv.slice(2);
    const named = (flag) => {
        const at = args.indexOf(flag);
        return at === -1 ? null : args[at + 1];
    };

    const [ip, pin] = args.filter((argument) => argument[0] !== '-');
    const privilege = named('--privilege') || 'Public';
    const password = named('--password') || Math.random().toString(36).slice(2, 12);

    ui.heading('mint');
    ui.blank();

    // Which television this pair will be for. Asking is the whole point: a
    // pair minted against the wrong device id signs packages that upload and
    // are then refused, with no message naming either.
    const duid = named('--duid') || (ip ? await duidOf(ip, pin) : null);

    if (!duid) {
        throw friendly(
            'Which television?\n\n' +
            '  npm run mint -- <tv-ip> <pin>        ask Tizen Homebrew on the TV\n' +
            '  npm run mint -- --duid <DUID>        when you already know it\n\n' +
            '  `npm run duid -- <tv-ip> [pin]` prints it on its own.'
        );
    }

    ui.info('device', duid);
    ui.info('privilege', privilege);
    ui.blank();

    ui.note('Sign in to your Samsung account:');
    ui.blank();
    ui.note(ui.style.dim(`  ${SIGN_IN}`));
    ui.blank();
    ui.note('Waiting for the browser to come back...');

    const account = await signIn();

    ui.blank();
    ui.ok('signed in', account.email || account.userId);

    const { SamsungCertificateCreator } = require('tizen');

    const authorInfo = {
        name: named('--name') || (account.email || 'tizen-homebrew').split('@')[0],
        email: account.email,
        password,
        privilegeLevel: privilege
    };

    const pair = await new SamsungCertificateCreator()
        .createCertificate(authorInfo, account, [duid])
        .catch((error) => {
            throw friendly(`Samsung refused to issue the certificate:\n\n  ${error.message}`);
        });

    const directory = named('--output') || certificates.DEFAULT_DIR;

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'author.p12'), Buffer.from(pair.authorCert, 'binary'));
    writeFileSync(join(directory, 'distributor.p12'), Buffer.from(pair.distributorCert, 'binary'));
    writeFileSync(join(directory, 'device-profile.xml'), pair.distributorXML);
    // Beside the certificates, because everything here looks for it there.
    writeFileSync(join(directory, 'author.pw'), password);

    ui.ok('written', directory);
    ui.blank();
    ui.note(`This pair signs only for ${duid}.`);
    ui.note(ui.style.dim('  npm run package                       build a widget it can install'));
    ui.note(ui.style.dim(`  npm run certs -- ${ip || '<tv-ip>'} <pin>       let the TV re-sign for itself`));
    ui.blank();
};

main().catch((err) => ui.crash(err));
