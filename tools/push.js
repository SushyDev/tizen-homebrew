'use strict';

// Installs a built package straight onto the TV over the LAN.
//
//   npm run push -- 192.168.2.9 <pin>
//
// This is the normal way to update once the TV is set up. Pinning the
// developer host IP to 127.0.0.1 is what makes the TV self-sufficient, and it
// deliberately takes sdb access away from every other machine — so `bootstrap`
// stops working at exactly the point everything starts working. This pushes to
// Tizen Homebrew instead, which is still allowed to drive sdb locally.
//
// The PIN is shown on the TV screen and changes every time the service starts.

const { readFileSync, readdirSync, existsSync, statSync } = require('fs');
const { join } = require('path');

const ui = require('./ui.js');
const { ROOT } = require('./config.js');

const WGT = 'release/tizenhomebrew.wgt';
const MANIFEST = 'config.xml';

// The parts of an app that a build rewrites, as tools/package.js stages them
// into the .wgt. config.xml and icon.png are packaged from the app directory
// too, but they are edited by hand rather than generated, so they are not the
// thing that goes quietly out of date.
const BUILT = ['ui/dist', 'service/dist'];

// Read from the manifest rather than hardcoded, so renaming a package cannot
// leave this talking to the wrong app.
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

// The newest mtime anywhere under a directory, or 0 if it is not there.
function newestUnder(dir) {
    if (!existsSync(dir)) return 0;

    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        // parentPath is the current name for it; Node 20 before 20.12 has only path.
        .map((entry) => statSync(join(entry.parentPath || entry.path, entry.name)).mtimeMs)
        .reduce((newest, at) => Math.max(newest, at), 0);
}

// Rounded, because what matters is the size of the gap rather than the number.
function describeGap(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;

    return `${Math.round(hours / 24)} days`;
}

// Warns when the package predates the build output it is supposed to contain.
//
// This uploads the .wgt exactly as it sits on disk, and nothing in `build`
// writes one — only `package` does. So `npm run build && npm run push`
// installs whatever was packaged last time, and does it silently: the upload
// succeeds, the TV comes back on a healthy build, and the change is simply not
// in it. A line here costs nothing next to finding that out from the far end.
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
            // Resigning and installing on the TV take a while.
            signal: AbortSignal.timeout(300000)
        });
    } catch (err) {
        // Installing Tizen Homebrew over itself tears down the very service
        // handling the request, so the connection drops before a reply
        // arrives. That looks identical to a failure but is usually success —
        // the only way to tell is to ask what build is running once it is
        // back. Reinstalling is not quick, so a minute is the patience this
        // needs; giving up early reports a successful install as a failure.
        const after = await waitForService(ip, 60);

        if (after) {
            const took = Date.now() - started;
            const size = ui.bytes(statSync(file).size);

            if (after.build !== buildBefore) {
                ui.ok('homebrew', `${size} · reconnected on ${after.build}`, took);
            } else {
                // Same stamp is not proof of failure: two builds from one
                // commit in the same minute are stamped identically. Say
                // exactly what is known rather than guessing either way.
                ui.ok('homebrew', `${size} · reconnected, still ${after.build}`, took);
                ui.warn('the build stamp did not change — commit, or rebuild, to tell them apart');
            }

            return { appId: appId(), version: after.build, selfRestarted: true };
        }

        throw friendly(
            `Could not reach Tizen Homebrew at ${ip}:${PORT} — ${err.message}\n\n` +
            '  Open Tizen Homebrew on the TV; the service only runs while it is open.'
        );
    }

    let result;
    try {
        result = await res.json();
    } catch (e) {
        throw friendly(`Tizen Homebrew replied with HTTP ${res.status} and no JSON.`);
    }

    if (!res.ok || !result.ok) {
        // The phases show how far it got, which is usually the useful part.
        const trace = (result.phases || []).map((p) => `      ${p}`).join('\n');

        // And where the television gave a refusal the service recognised, the
        // sentence saying what to do about it — decided once, on the TV, in
        // service/src/install/verdicts.js, so this reads the same as the phone.
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

// Waits for the service to answer at all, and reports what it came back on.
//
// Waiting for a *different* build is the tempting version and it is wrong in
// both directions. Two builds from the same commit inside the same minute
// carry the same stamp, so a perfectly good install can look like nothing
// happened; and a reinstall that failed brings the old service back, which
// looks like nothing happened for a completely different reason. Neither is
// knowable from here, so this reports the fact — came back, on this build —
// and lets the caller say what it means.
async function waitForService(ip, seconds) {
    for (let i = 0; i < (seconds || 60); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const version = await get(ip, '/version');
        if (version && version.build) return version;
    }
    return null;
}

// Tizen Homebrew's service is background-support="enable", so it outlives a
// reinstall: new code sits on disk while the old process keeps serving. This
// asks it to exit so the platform brings it back on the new build, then waits
// for a different build stamp to appear.
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

    // The TV page relaunches the service when it next polls, and launching the
    // app does too. Nudge it rather than waiting for a person.
    await fetch(`http://${ip}:8001/api/v2/applications/${appId()}`, { method: 'POST' })
        .catch(() => null);

    return waitForService(ip, 60);
}

// Confirms against the TV's own application registry rather than trusting the
// reply, the same way the bootstrap does.
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

    // /version is served by the service being replaced, so this is the build
    // on its way out.
    const before = await get(ip, '/version');
    if (before && before.build) ui.info('running', before.build);
    ui.blank();

    const result = await pushOne(ip, pin, before && before.build);

    const registered = await confirm(ip, result.appId);
    if (!registered) ui.warn('installed, but not in the TV\'s app list yet');

    // The service is background-support="enable", so it outlives its own
    // reinstall: new code sits on disk while the old process keeps serving.
    // Unless the install already took it down, it has to be asked to exit.
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
