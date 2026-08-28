'use strict';

// Sends this machine's signing certificates to a television.
//
//   npm run certs -- 192.168.2.9 <pin>
//   npm run certs -- 192.168.2.9 <pin> --forget
//
// A Tizen package names the device it may be installed on, so from Tizen 7 a
// package signed anywhere else is refused. Tizen Homebrew answers that by
// re-signing what it installs — but only if it is holding a certificate pair
// minted for the television it is running on. This is how the pair gets there.
//
// It goes over the same PIN-gated HTTP the installer uses, so it works after
// the developer host IP has been pinned to loopback, which is the state a set
// spends its life in.

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const ui = require('./ui.js');
const certificates = require('./certificates.js');

const PORT = 8091;
const DEFAULT_DIR = join(homedir(), '.tizen-certs');

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const main = async () => {
    const args = process.argv.slice(2);
    const [ip, pin] = args.filter((argument) => argument[0] !== '-');
    const forget = args.indexOf('--forget') !== -1;

    if (!ip || !pin) {
        throw friendly(
            'Usage:  npm run certs -- <tv-ip> <pin> [--forget]\n\n' +
            '  The PIN is on the TV screen, and changes each time the service starts.\n' +
            `  Certificates are read from ${DEFAULT_DIR}, or TIZEN_AUTHOR_P12's directory.`
        );
    }

    // Everything about the pair on this machine: where it is, and the one
    // password that opens both halves.
    const gather = () => {
        const authorPath = process.env.TIZEN_AUTHOR_P12 || join(DEFAULT_DIR, 'author.p12');
        const distributorPath = process.env.TIZEN_DISTRIBUTOR_P12 || join(authorPath, '..', 'distributor.p12');
        const passwordPath = join(authorPath, '..', 'author.pw');

        const password = process.env.TIZEN_AUTHOR_PW ||
            (existsSync(passwordPath) ? readFileSync(passwordPath, 'utf8').trim() : null);

        const missing = [authorPath, distributorPath].filter((path) => !existsSync(path));

        if (missing.length) {
            throw friendly(
                `No certificate at:\n  ${missing.join('\n  ')}\n\n  ${certificates.howToMint()}`
            );
        }

        if (!password) {
            throw friendly(
                'No password for the certificates.\n\n' +
                `  Put it in ${passwordPath}, or set TIZEN_AUTHOR_PW.`
            );
        }

        return {
            authorCert: readFileSync(authorPath).toString('base64'),
            distributorCert: readFileSync(distributorPath).toString('base64'),
            password
        };
    };

    const ask = async (method, body) => {
        const response = await fetch(`http://${ip}:${PORT}/certificates`, {
            method,
            headers: { 'content-type': 'application/json', 'x-homebrew-pin': pin },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20000)
        }).catch((error) => {
            throw friendly(
                `Could not reach Tizen Homebrew at ${ip}:${PORT} — ${error.message}\n\n` +
                '  Open Tizen Homebrew on the TV; the service only runs while it is open.'
            );
        });

        const answer = await response.json().catch(() => ({}));

        if (!response.ok || !answer.ok) {
            throw friendly(`The TV refused: ${answer.message || response.status}`);
        }

        return answer;
    };

    ui.heading('certs', `${ip}:${PORT}`);
    ui.blank();

    if (forget) {
        await ask('DELETE');
        ui.ok('forgotten', 'the TV is holding no certificates');
        ui.blank();
        return;
    }

    const result = await ask('POST', gather());

    ui.ok('stored', result.device || 'an unnamed device');

    if (result.matchesThisTv === false) {
        ui.warn('these certificates name a different television — installs will be refused');
        ui.note(ui.style.dim('  `npm run duid -- <tv-ip>` says which device this set is'));
    } else {
        ui.note(ui.style.dim('  every install from here on is re-signed for this television'));
    }

    ui.blank();
};

main().catch((err) => ui.crash(err));
