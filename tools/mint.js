'use strict';

// Minting a certificate pair for one television. Point it at an address and it resolves the DUID
// itself, which is the way round that cannot go wrong.
//
// One distributor certificate names several devices, so a second set adds to the list; the author
// certificate is kept, because Tizen refuses to update across a changed one and recovering needs sdb.
//
// `tizenjs create-samsung-cert` cannot do this today — it reads Samsung's authorization code as an
// access token — so this serves the `check.do` redirect on localhost and calls the creator directly.

const { createServer } = require('http');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const args = require('./args.js');
const certificates = require('./certificates.js');
const { duidOf, whyNoDuid } = require('./tv.js');

const VALUED = ['--duid', '--privilege', '--password', '--name', '--output'];

// The port registered in the redirect_uri Samsung sends the browser back to.
const CALLBACK_PORT = 4794;
const CALLBACK = `http://localhost:${CALLBACK_PORT}/signin/callback`;

const SIGN_IN = 'https://account.samsung.com/mobile/account/check.do' +
    `?serviceID=v285zxnl3h&actionID=StartOAuth2&accessToken=Y&redirect_uri=${CALLBACK}`;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

// The answer arrives as a form POST whose `code` field is a JSON document, whatever the field is called.
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
    const argv = args.parse(process.argv.slice(2), VALUED);
    const named = (flag) => argv.value(flag);

    const [ip, pin] = argv.positionals;
    const privilege = named('--privilege') || 'Public';
    const password = named('--password') || Math.random().toString(36).slice(2, 12);

    ui.heading('mint');
    ui.blank();

    // Asking is the whole point: a pair minted against the wrong device id signs packages that upload and are
    // then refused, naming neither.
    const listed = named('--duid');

    const asked = listed
        ? listed.split(',').map((device) => device.trim()).filter(Boolean)
        : (ip ? [await duidOf(ip, pin)].filter(Boolean) : []);

    if (!ip && !asked.length) {
        throw friendly(
            'Which television?\n\n' +
            '  npm run mint -- <tv-ip>              ask the TV over sdb\n' +
            '  npm run mint -- <tv-ip> <pin>        ask Tizen Homebrew on the TV\n' +
            '  npm run mint -- --duid <DUID>        when you already know it\n' +
            '  npm run mint -- --duid <A>,<B>,<C>   several at once'
        );
    }

    if (!asked.length) throw friendly(whyNoDuid(ip, pin));

    const existing = certificates.locate();
    const covered = certificates.devicesIn(existing.distributor, existing.distributorPassword);

    const devices = asked.reduce(
        (all, device) => (all.indexOf(device) === -1 ? all.concat(device) : all),
        covered
    );

    const keeping = !argv.has('--new-author') && Boolean(existing.password) && existsSync(existing.author) && covered.length > 0;

    if (ip && !listed) ui.info('asked', `${ip} ${pin ? 'through Tizen Homebrew' : 'over sdb'}`);

    ui.info('adding', asked.map((device) => device + (covered.indexOf(device) === -1 ? '' : ' (already covered)')).join(', '));
    ui.info('covering', devices.join(', '));
    ui.info('author', keeping ? 'keeping the one on this machine' : 'minting a new one');
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
    const creator = new SamsungCertificateCreator();

    const authorInfo = {
        name: named('--name') || (account.email || 'tizen-homebrew').split('@')[0],
        email: account.email,
        password: keeping ? existing.password : password,
        privilegeLevel: privilege
    };

    // Only the distributor names devices, and the two certificates are independent.
    const mintDistributor = async () => {
        await creator._downloadVDCertificates();

        const request = creator._generateDistributorCert(authorInfo, devices);

            const profile = await creator._fetchDistributorCert(account, authorInfo, request);
        const issued = await creator._fetchDistributorCert(account, authorInfo, request);

        return {
            distributorCert: await creator._generateDistributorPKCS12(request, issued, authorInfo),
            distributorXML: profile
        };
    };

    const minted = await (keeping ? mintDistributor() : creator.createCertificate(authorInfo, account, devices))
        .catch((error) => {
            throw friendly(`Samsung refused to issue the certificate:\n\n  ${error.message}`);
        });

    const directory = named('--output') || certificates.DEFAULT_DIR;

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'distributor.p12'), Buffer.from(minted.distributorCert, 'binary'));
    writeFileSync(join(directory, 'device-profile.xml'), minted.distributorXML);

    if (!keeping) {
        writeFileSync(join(directory, 'author.p12'), Buffer.from(minted.authorCert, 'binary'));
        writeFileSync(join(directory, 'author.pw'), password);
    }

    ui.ok('written', directory);
    ui.blank();

    ui.note(keeping
        ? 'The author certificate is unchanged, so televisions already running this keep updating.'
        : 'A new author certificate. Any television already running this needs `--replace` once:');

    if (!keeping) ui.note(ui.style.dim('  npm run bootstrap -- <tv-ip> --replace   (needs sdb — see the README)'));

    ui.blank();
    ui.note(`This pair signs for ${devices.length === 1 ? devices[0] : `${devices.length} televisions: ${devices.join(', ')}`}.`);
    ui.note(ui.style.dim('  npm run package                          build a widget they can install'));
    ui.note(ui.style.dim(`  npm run certs -- ${ip || '<tv-ip>'} <pin>          let a TV re-sign for itself`));
    ui.blank();
};

main().catch((err) => ui.crash(err));
