'use strict';

// Minting a certificate pair for one television.
//
//   npm run mint -- 192.168.2.9           asks the TV which device it is
//   npm run mint -- 192.168.2.9 <pin>     the same, once the TV is pinned to loopback
//   npm run mint -- --duid BDCPQZFMHIZII  when you already know
//   npm run mint -- <tv-ip> <pin> --new-author   start the pair over
//
// Point it at a television and it resolves the DUID itself, which is the way
// round that cannot go wrong. Copying one by hand can: a model name and a
// device id are both thirteen anonymous characters, and a pair minted against
// the wrong string signs packages the TV refuses with "Check certificate
// error", naming neither.
//
// Public, which is the level anybody can mint for themselves. The app claims
// no privilege above it — see config.xml, where two Samsung ones were dropped
// precisely so that stays true — and a certificate that reaches further than
// the package needs is a certificate that has to be explained to everybody who
// installs it. `--privilege Partner` is there if an app ever needs one.
//
// A second television does not need a second pair. One distributor
// certificate can name several devices, and this adds to the list rather than
// replacing it — so the pair on this machine ends up covering every set you
// have asked it about.
//
// The author certificate is kept. That is the important half: Tizen refuses to
// *update* an app whose author certificate has changed —
//
//     install failed[118, -11], reason: Author certificate not match
//
// — and recovering from that means uninstalling, which needs sdb, which means
// walking to the television and pointing its developer host IP back at a
// computer. Minting a new author every time you add a TV would impose that on
// every set you already had. So it happens once, and `--new-author` is the way
// to say you meant it.
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
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const args = require('./args.js');
const certificates = require('./certificates.js');
const { duidOf, whyNoDuid } = require('./tv.js');

// The flags that consume the token after them. Without this, `--duid <DUID>`
// left the DUID sitting in the slot the TV address is read from — see args.js.
const VALUED = ['--duid', '--privilege', '--password', '--name', '--output'];

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
    const argv = args.parse(process.argv.slice(2), VALUED);
    const named = (flag) => argv.value(flag);

    const [ip, pin] = argv.positionals;
    const privilege = named('--privilege') || 'Public';
    const password = named('--password') || Math.random().toString(36).slice(2, 12);

    ui.heading('mint');
    ui.blank();

    // Which televisions this pair will be for. Asking is the whole point: a
    // pair minted against the wrong device id signs packages that upload and
    // are then refused, with no message naming either.
    //
    // Several can be named at once, because collecting device ids is the part
    // of setting up a fleet that costs a walk to each set — and every mint
    // after the first is another sign-in.
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

    // A television that was named and would not answer. Saying so here, rather
    // than falling through to "which television?", is the difference between an
    // address to fix and a question about what was typed.
    if (!asked.length) throw friendly(whyNoDuid(ip, pin));

    // Every television this pair already covers, plus the one being added. A
    // second set costs a distributor certificate, not a new everything.
    const existing = certificates.locate();
    const covered = certificates.devicesIn(existing.distributor, existing.distributorPassword);

    const devices = asked.reduce(
        (all, device) => (all.indexOf(device) === -1 ? all.concat(device) : all),
        covered
    );

    // Keeping the author is the default, and the reason is in the header.
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

    // Only the distributor names devices, and only the distributor is fetched
    // when an author certificate is being kept. The two are independent: the
    // distributor carries its own key and its own chain, and Samsung issues it
    // without reference to the author.
    const mintDistributor = async () => {
        await creator._downloadVDCertificates();

        const request = creator._generateDistributorCert(authorInfo, devices);

        // Called twice because createCertificate calls it twice, once for the
        // profile and once for the certificate. Whether that is deliberate or
        // a slip in the library, it is what works today.
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
        // Beside the certificates, because everything here looks for it there.
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
