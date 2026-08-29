'use strict';

const { readFileSync, readdirSync, existsSync, statSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');

const WGT = 'release/homebrew.wgt';
const MANIFEST = 'config.xml';

const BUILT = ['ui/dist', 'service/dist'];

function appId() {
    const match = readFileSync(join(ROOT, MANIFEST), 'utf8')
        .match(/<tizen:application\b[^>]*\bid="([^"]+)"/);
    if (!match) throw friendly(`Could not read the application id from ${MANIFEST}.`);
    return match[1];
}

const PORT = 8091;

function friendly(message) {
    return Object.assign(new Error(message), { isFriendly: true });
}

function newestUnder(dir) {
    if (!existsSync(dir)) return 0;

    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => statSync(join(entry.parentPath || entry.path, entry.name)).mtimeMs)
        .reduce((newest, at) => Math.max(newest, at), 0);
}

function describeGap(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;

    return `${Math.round(hours / 24)} days`;
}

// Nothing in `build` writes a .wgt — only `package` does — so `npm run build && npm run push`
// silently installs whatever was packaged last time.
function checkFreshness() {
    const packagedAt = statSync(join(ROOT, WGT)).mtimeMs;
    const newest = BUILT.reduce((at, part) => Math.max(at, newestUnder(join(ROOT, part))), 0);

    if (newest <= packagedAt) return;

    ui.warn(`${WGT} predates its build output by ${describeGap(newest - packagedAt)} ` +
        '— the TV will get the previously packaged build');
    ui.note(ui.style.dim('    Package first:  npm run package'));
}

async function pushOne(ip, pin, buildBefore) {
    const file = join(ROOT, WGT);
    if (!existsSync(file)) {
        throw friendly(`No package at ${WGT}\n  Build one first:  npm run package`);
    }

    checkFreshness();

    const body = readFileSync(file);
    const started = Date.now();

    let res;
    try {
        res = await fetch(`http://${ip}:${PORT}/install`, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-homebrew-pin': pin,
                'x-homebrew-name': 'homebrew'
            },
            body,
            signal: AbortSignal.timeout(300000)
        });
    } catch (err) {
        const after = await waitForService(ip, 60);

        if (after) {
            const took = Date.now() - started;
            const size = ui.bytes(statSync(file).size);

            if (after.build !== buildBefore) {
                ui.ok('homebrew', `${size} · reconnected on ${after.build}`, took);
            } else {
                ui.ok('homebrew', `${size} · reconnected, still ${after.build}`, took);
                ui.warn('the build stamp did not change — commit, or rebuild, to tell them apart');
            }

            return { appId: appId(), version: after.build, selfRestarted: true };
        }

        throw friendly(
            `Tizen Homebrew at ${ip}:${PORT} did not come back within a minute — ${err.message}\n\n` +
            '  The install has probably finished; the service only runs while the app is\n' +
            '  open, and a set that had moved on will not reopen it by itself.\n\n' +
            '  Open Tizen Homebrew on the TV, then check:  npm run push -- ' + `${ip} <pin>`
        );
    }

    let result;
    try {
        result = await res.json();
    } catch (e) {
        throw friendly(`Tizen Homebrew replied with HTTP ${res.status} and no JSON.`);
    }

    if (!res.ok || !result.ok) {
        const trace = (result.phases || []).map((p) => `      ${p}`).join('\n');

        const advice = result.remedy
            ? `\n  ${result.remedy.split('\n').join('\n  ')}\n`
            : '';

        throw friendly(
            `The install failed: ${result.message || res.status}\n` +
            (trace ? `\n${trace}\n` : '') + advice
        );
    }

    ui.ok('homebrew', `${ui.bytes(statSync(file).size)} · v${result.version || '?'}`, Date.now() - started);
    return result;
}

function get(ip, path, pin) {
    return fetch(`http://${ip}:${PORT}${path}`, {
        headers: pin ? { 'x-homebrew-pin': pin } : {},
        signal: AbortSignal.timeout(8000)
    }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
}

// Waiting for a different build stamp is wrong in both directions: two builds from one commit in
// the same minute are stamped identically, and a failed reinstall brings the old service back.
async function waitForService(ip, seconds) {
    for (let i = 0; i < (seconds || 60); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const version = await get(ip, '/version');
        if (version && version.build) return version;
    }
    return null;
}

// The service is background-support="enable", so it outlives its own reinstall: new code sits on
// disk while the old process keeps serving, and it has to be asked to exit.
async function restartService(ip, pin) {
    try {
        await fetch(`http://${ip}:${PORT}/restart`, {
            method: 'POST',
            headers: { 'x-homebrew-pin': pin },
            signal: AbortSignal.timeout(8000)
        });
    } catch (e) {
        // The service exiting can cut the response short; that is success.
    }

    await fetch(`http://${ip}:8001/api/v2/applications/${appId()}`, { method: 'POST' })
        .catch(() => null);

    return waitForService(ip, 60);
}

async function confirm(ip, appId) {
    try {
        const res = await fetch(`http://${ip}:8001/api/v2/applications/${appId}`, {
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function main() {
    const [ip, pin] = process.argv.slice(2).filter((a) => a[0] !== '-');

    if (!ip || !pin) {
        throw friendly(
            'Usage:  npm run push -- <tv-ip> <pin>\n\n' +
            '  The PIN is on the TV screen, and changes each time the service starts.'
        );
    }

    ui.heading('push', `${ip}:${PORT}`);
    ui.blank();

    const before = await get(ip, '/version');
    if (before && before.build) ui.info('running', before.build);
    ui.blank();

    const result = await pushOne(ip, pin, before && before.build);

    const registered = await confirm(ip, result.appId);
    if (!registered) ui.warn('installed, but not in the TV\'s app list yet');

    if (!result.selfRestarted) {
        ui.blank();
        const after = await restartService(ip, pin);

        if (after) {
            ui.ok('service reloaded', after.build);
        } else {
            ui.warn('the service did not come back on a new build — restart the TV');
        }
    }

    ui.blank();
    ui.note('Done — no sdb involved, so the developer IP stays on 127.0.0.1.');
    ui.note(ui.style.dim('The service restarted, so its PIN has changed — check the TV screen.'));
    ui.blank();
}

main().catch((err) => ui.crash(err));
