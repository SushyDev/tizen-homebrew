'use strict';

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const ui = require('./ui.js');
const certificates = require('./certificates.js');

const PORT = 8091;
const DEFAULT_DIR = join(homedir(), '.tizen-certs');

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

// Sends this machine's signing certificates over the same PIN-gated HTTP the installer uses.
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
            author: certificates.asPem(readFileSync(authorPath), password),
            distributor: certificates.asPem(readFileSync(distributorPath), password),
            devices: certificates.devicesIn(distributorPath, password)
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

    const named = (result.devices && result.devices.length ? result.devices : [result.device])
        .filter(Boolean);

    ui.ok('stored', named.join(', ') || 'an unnamed device');

    if (result.matchesThisTv === false) {
        ui.warn(result.thisTv
            ? `these certificates name ${named.join(', ') || 'nothing'}, but this television is ${result.thisTv} — installs will be refused`
            : 'these certificates name a different television — installs will be refused');
        ui.blank();
        ui.note(ui.style.dim('  Mint a pair bound to this one and send it again:'));
        ui.note(ui.style.dim(`    npm run mint -- ${ip} ${pin}`));
        ui.note(ui.style.dim(`    npm run certs -- ${ip} <pin>`));
    } else {
        ui.note(ui.style.dim(named.length > 1
            ? `  every install from here on is re-signed for this television, one of the ${named.length} this pair covers`
            : '  every install from here on is re-signed for this television'));
    }

    ui.blank();
};

main().catch((err) => ui.crash(err));
