'use strict';

// Tizen Homebrew, assembled.
//
// Read this file top to bottom and you have the whole service: what it knows,
// what it exposes, and who is allowed to ask. Everything it actually *does*
// lives in the modules it pulls together, so this stays a table of contents
// rather than an implementation.
//
// The shape is deliberate. Tizen Homebrew runs on the TV, which is the only
// machine still permitted to reach the TV's own sdb daemon once Developer
// Mode is pinned to loopback. That single fact is why this exists: it lends its
// position to a phone, or to a laptop, over the LAN.

const { createServer } = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, normalize } = require('path');
const { homedir } = require('os');

const { startRecording, Facility } = require('./obs/log.js');
const { size, took, host } = require('./obs/units.js');

// Installed before anything else can produce output worth keeping.
const recorded = startRecording();
const log = recorded.log;

const { createStore } = require('./state.js');
const { createRouter } = require('./http/router.js');
const { json, failure, bytes, readBody } = require('./http/respond.js');
const pin = require('./auth/pin.js');
const device = require('./tv/device.js');
const sdb = require('./tv/sdb.js');
const packages = require('./tv/packages.js');
const { Relay } = require('./tv/relay.js');
const config = require('./config.js');
const protocol = require('./protocol.js');
const { createInstaller } = require('./install/pipeline.js');
const { createCatalog } = require('./install/catalog.js');
const { createUpdates } = require('./install/updates.js');

const { ErrorCode } = protocol;

// 8080 is already taken on Samsung TVs by a system service, which answers with
// `Server: WebServer`. Binding there fails with EADDRINUSE and the app simply
// appears to hang, which cost an evening to work out once.
const PORT = Number(process.env.HOMEBREW_PORT) || 8091;

// Replaced at build time. The package version barely moves between builds, so
// it cannot answer "is the code I just pushed the code that is running" — and
// Tizen Homebrew's service survives its own reinstall, which makes that a
// real question rather than a pedantic one.
const BUILD = '__HOMEBREW_BUILD__';
const ORIGIN = '__HOMEBREW_ORIGIN__';

const start = () => {
    const startedAt = new Date().toISOString();
    const secret = pin.generate();

    const svc = log.on(Facility.SVC);
    const net = log.on(Facility.NET);
    const dev = log.on(Facility.DEV);

    // The first thing in the log, and the thing every bug report needs: which
    // build is running, on what, as whom.
    svc.info(`tizen homebrew ${BUILD} starting`);
    svc.info(`node ${process.version} on ${process.platform}/${process.arch}, pid ${process.pid}`);
    log.on(Facility.AUTH).info(`pairing pin ${secret} — regenerated every start`);

    const store = createStore({
        installing: false,
        catalog: [],
        catalogStale: false,
        lockout: pin.fresh(),
        device: null
    });

    // The built-in origin is baked in at build time, which means changing it
    // otherwise costs a reinstall on every television that has this on it. So
    // the stored configuration can name a different one, and does not have to
    // be recompiled to do it.
    const stored = config.read().catalogUrl;
    const catalogUrl = stored || `${ORIGIN}/catalog.json`;
    const catalogCache = join(homedir(), 'share', 'homebrewCatalog.json');

    const catalog = createCatalog({ url: catalogUrl, cachePath: catalogCache, log });

    // Which of those apps are already here, and which have released something
    // newer since. Tizen Homebrew is one of them: the catalogue is how it
    // reaches its own next version, so the app list on a phone is also the
    // update button for the thing drawing it.
    const updates = createUpdates({ packages, log });

    // Asking the set what it is holding takes six seconds on a television with
    // three hundred packages on it, and every catalogue sent to a phone is
    // marked with the answer. Asked for now, while nothing is waiting on it, so
    // that the first phone to connect is not the one that pays for it.
    updates.prime();

    log.on(Facility.CAT).info(`origin ${catalogUrl}${stored ? ' (from the stored configuration)' : ''}`);
    log.on(Facility.CFG).info(`cache ${catalogCache}`);

    const relay = new Relay({
        enabled: config.read().relayEnabled,
        packageId: device.onTv ? tizen.application.getAppInfo().packageId : null,
        log: (message) => log.on(Facility.RELAY).info(message)
    });

    // Off by default, and the one setting worth saying out loud when it is
    // not: it is arbitrary command execution as the TV's developer user.
    if (relay.enabled) log.on(Facility.RELAY).warn('the command relay is ON from stored configuration');

    // Re-signing, bound to whatever certificates this television is holding.
    //
    // Loaded on first use rather than at startup: it pulls in node-forge, jszip
    // and an XML canonicaliser, and a TV that never installs anything should
    // not pay to parse them. The certificates are read at the same moment for
    // the same reason a session is — so a pair sent to the TV a second ago is
    // the pair that signs the next install, with nothing to invalidate.
    const resigner = async () => {
        const { resign } = require('./install/resign.js');

        return (archive) => resign(archive, config.read());
    };

    const installer = createInstaller({ sdb, device, config, resigner, store, log });

    // --------------------------------------------------------------- state

    // Only *changes* are logged. The probe runs every fifteen seconds and a
    // steady state repeated four times a minute would bury everything else in
    // the log within an hour — while a route that comes and goes is exactly
    // the fault this whole service exists to make visible.
    const announce = (state, previous) => {
        if (!previous) {
            dev.info(state.onTv
                ? `tizen ${state.platformVersion || 'unknown'}` +
                  `${state.needsResign ? ' — packages must be re-signed for this firmware' : ''}`
                : 'not running on a television — this is a development harness');

            if (state.onTv && state.developerMode === false) dev.warn('developer mode is off');
        } else if (previous.ready === state.ready) {
            return state;
        }

        if (state.ready) {
            log.on(Facility.SDB).ok(`loopback 127.0.0.1:${sdb.SDB_PORT} answered — this TV can install its own apps`);
        } else if (state.onTv) {
            log.on(Facility.SDB).warn(`loopback 127.0.0.1:${sdb.SDB_PORT} is not usable (${state.sdbError || state.reason || 'unknown'})`);
            dev.warn(state.reason === 'debugModeOff'
                ? 'turn Developer Mode on in Apps › 12345 › Settings, then restart the TV'
                : 'set Host PC IP to 127.0.0.1 in Apps › 12345 › Settings, then restart the TV');
            dev.info('sdbd only reads that value at startup, which is why the restart is not optional');
        }

        return state;
    };

    const refreshDevice = async () => {
        const previous = store.select('device');
        const state = await device.probe();

        store.update({ device: state });

        return announce(state, previous);
    };

    refreshDevice();
    if (device.onTv) setInterval(refreshDevice, 15000);

    // ---------------------------------------------------------------- auth

    const fromLoopback = (request) => {
        const address = (request.socket && request.socket.remoteAddress) || '';
        return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    };

    /**
     * Checks a presented PIN, applying the lockout.
     *
     * Returns `{ ok }` or `{ ok: false, code, message }` so callers can answer
     * over HTTP or the socket without each inventing its own wording.
     */
    const authorise = (presented) => {
        const lockout = store.select('lockout');

        if (pin.isLocked(lockout)) {
            const seconds = Math.ceil(pin.remaining(lockout) / 1000);
            return { ok: false, code: ErrorCode.LOCKED_OUT, message: `Too many incorrect PINs. Try again in ${seconds}s.` };
        }

        if (!pin.matches(presented, secret)) {
            store.update({ lockout: pin.recordFailure(lockout) });
            return { ok: false, code: ErrorCode.UNAUTHORIZED, message: 'Wrong or missing PIN.' };
        }

        store.update({ lockout: pin.recordSuccess() });
        return { ok: true };
    };

    // The TV's own addresses, so the screen can show a URL a phone can type.
    // Read from the interfaces because the page's webapis.network.getIp() is
    // missing on some models and the device API's `ip` can lag.
    const lanAddresses = () => {
        const interfaces = require('os').networkInterfaces();
        const wiredFirst = (name) => (/^(eth|en)/.test(name) ? 0 : /^(wlan|wl)/.test(name) ? 1 : 2);

        return Object.entries(interfaces)
            .flatMap(([name, entries]) => (entries || [])
                .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
                .map((entry) => ({ address: entry.address, iface: name })))
            .sort((a, b) => wiredFirst(a.iface) - wiredFirst(b.iface));
    };

    // -------------------------------------------------------------- routes

    // The TV's own page polls this service several times a second: the log it
    // is displaying, the readiness band, the pairing code. Those requests are
    // the log being *read*, not the system doing anything — and recording them
    // would mean every poll produced a line that the next poll then delivered,
    // forever. They are logged at debug, which is off unless HOMEBREW_DEBUG
    // says otherwise. Everything from anywhere else is an event.
    const POLLED = ['/logs', '/state', '/pin', '/version', '/health'];

    const quiet = (request, path) =>
        request.method === 'GET' && fromLoopback(request) && POLLED.indexOf(path) !== -1;

    const router = createRouter({ log, quiet });

    // Which build is running. Deliberately unauthenticated: `push` reads it
    // before and after an update to tell whether new code actually took, and
    // it reveals nothing a client could not learn by looking at the app list.
    router.on.get('/version', (_request, response) => json(response, {
        build: BUILD,
        node: process.version,
        startedAt,
        uptimeSeconds: Math.round(process.uptime())
    }));

    router.on.get('/health', (_request, response) => json(response, {
        ok: true,
        port: PORT,
        onTv: device.onTv,
        addresses: lanAddresses().map((entry) => entry.address)
    }));

    // The PIN itself only ever leaves over loopback — the TV's own page reads
    // it to display it. A phone on the LAN must be told it by a person.
    router.on.get('/pin', (request, response) => {
        if (!fromLoopback(request)) {
            return failure(response, 403, ErrorCode.UNAUTHORIZED, 'Only readable from the TV itself.');
        }

        const addresses = lanAddresses();

        json(response, {
            pin: secret,
            port: PORT,
            addresses: addresses.map((entry) => entry.address),
            url: addresses.length ? `http://${addresses[0].address}:${PORT}` : null
        });
    });

    router.on.get('/state', (request, response) => {
        if (!fromLoopback(request)) {
            return failure(response, 403, ErrorCode.UNAUTHORIZED, 'Only readable from the TV itself.');
        }
        refreshDevice().then((state) => json(response, state));
    });

    const authorisedRead = (request, response, handle) => {
        if (fromLoopback(request)) return handle();

        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        return handle();
    };

    // The log, as records rather than as text. `uptime` comes with them so a
    // client can put its own events on this service's clock: the TV page
    // writes lines of its own — a launch it attempted, an error in the page —
    // and they belong in the same dmesg as everything else, in order.
    router.on.get('/logs', (request, response, { query }) =>
        authorisedRead(request, response, () =>
            json(response, { lines: recorded.since(query.get('since')), uptime: recorded.uptime() })));

    router.on.get('/packages', (request, response) =>
        authorisedRead(request, response, () =>
            packages.list().then(
                (list) => json(response, { ok: true, packages: list }),
                (error) => failure(response, 500, error.code || ErrorCode.INTERNAL, error.message))));

    // Installing a package sent straight here, so a build machine can update
    // the TV over the LAN. Pinning the developer IP to loopback removes sdb
    // from every other machine, which would otherwise leave no way in.
    router.on.post('/install', async (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);

        const phases = [];
        const began = Date.now();
        const archive = await readBody(request);

        log.on(Facility.PKG).info(`${host(request.socket && request.socket.remoteAddress)} uploaded ` +
            `${size(archive.length)}${request.headers['x-homebrew-name'] ? ` as ${request.headers['x-homebrew-name']}` : ''} ` +
            `in ${took(Date.now() - began)}`);

        try {
            const outcome = await installer.install(
                { source: 'upload', reference: request.headers['x-homebrew-name'], upload: archive },
                (phase, detail) => phases.push(detail ? `${phase}: ${detail}` : phase)
            );

            // Same reason as the socket's install path: the set is holding
            // something new, and the next app list has to say so.
            updates.changed();

            json(response, { ok: true, phases, ...outcome });
        } catch (error) {
            failure(response, 500, error.code || ErrorCode.INTERNAL, error.message, error.remedy);
            // The phases show how far it got, which is usually the useful part.
            log.on(Facility.PKG).err(`upload install stopped after: ${phases.join(', ') || 'nothing'}`);
        }
    });

    // The certificate pair this television signs with.
    //
    // Sent here once, over the PIN, and kept in the same place as everything
    // else that has to survive a reinstall. There is no route that reads them
    // back: a client can learn that certificates exist and which device they
    // are for, which is everything it needs to render a state, and nothing it
    // could sign with.
    router.on.post('/certificates', async (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);

        const sent = await readBody(request, 4 * 1024 * 1024);

        const pair = (() => {
            try {
                return JSON.parse(sent.toString('utf8'));
            } catch (e) {
                return null;
            }
        })();

        const missing = ['authorCert', 'distributorCert', 'password']
            .filter((field) => typeof (pair || {})[field] !== 'string' || !pair[field]);

        if (missing.length) {
            return failure(response, 400, ErrorCode.BAD_MESSAGE,
                `A certificate pair needs ${missing.join(', ')}.`);
        }

        // Opened before it is stored, so a pair that cannot be used is refused
        // now rather than at the end of somebody's next install — and so the
        // device it names is read off the certificate itself rather than
        // believed from whoever sent it.
        const { devicesOf, openPair } = require('./install/resign.js');

        const opened = (() => {
            try {
                return openPair(pair);
            } catch (error) {
                return { error };
            }
        })();

        if (opened.error) {
            return failure(response, 400, ErrorCode.RESIGN_FAILED, opened.error.message);
        }

        // Every device it names, not the first: one distributor certificate
        // covers a `--duidList`, and judging it by entry zero refused installs
        // on televisions the pair was perfectly good for.
        const devices = devicesOf(opened.distributor);
        const device = devices[0] || null;
        const state = store.select('device');
        const here = state && state.duid;

        config.update({
            authorCert: pair.authorCert,
            distributorCert: pair.distributorCert,
            password: pair.password,
            certDuid: device,
            certDuids: devices,
            certCreatedAt: new Date().toISOString()
        });

        const mismatched = Boolean(here && devices.length && devices.indexOf(here) === -1);

        log.on(Facility.CFG)[mismatched ? 'warn' : 'ok'](
            `certificates stored for ${devices.join(', ') || 'an unnamed device'}` +
            (mismatched ? `, but this television is ${here} — installs will be refused` : ''));

        json(response, { ok: true, device, devices, matchesThisTv: !mismatched, thisTv: here || null });
    });

    router.on.delete('/certificates', (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        config.forgetCertificates();
        log.on(Facility.CFG).info('certificates forgotten');

        json(response, { ok: true });
    });

    // Exits so the platform starts the service again on newly installed code.
    // Its background-support means it outlives a reinstall, so without this a
    // pushed Tizen Homebrew build sits on disk unused until the TV is restarted.
    router.on.post('/restart', (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        json(response, { ok: true, restarting: true, build: BUILD });

        svc.warn(`${host(request.socket && request.socket.remoteAddress)} asked for a restart`);

        setTimeout(() => {
            svc.info(`exiting after ${took(recorded.uptime())} so the platform reloads the service on new code`);
            process.exit(0);
        }, 300);
    });

    // The phone UI, served from inside the package.
    // Vite emits one inlined index.html; in the packaged app it sits at
    // ui/dist next to the service, and running from source it is one level up.
    const uiRoot = [
        join(__dirname, '..', '..', 'ui', 'dist'),
        join(__dirname, '..', 'ui', 'dist'),
        join(__dirname, '..', '..', 'ui')
    ].find(existsSync);

    if (uiRoot) {
        svc.info(`serving the phone UI from ${uiRoot}`);
    } else {
        svc.err('no UI assets in this build — the phone will get a 500 and nothing else');
    }

    router.on.get('/*', (request, response, { path }) => {
        if (!uiRoot) return failure(response, 500, ErrorCode.INTERNAL, 'UI assets are missing from this build.');

        const requested = path === '/' ? '/index.html' : path;
        const file = join(uiRoot, normalize(requested));

        // normalize collapses "..", and this confirms the result is still
        // inside the UI directory — a path traversal here would serve any
        // file on the TV to anyone on the network.
        if (!file.startsWith(uiRoot) || !existsSync(file)) {
            return failure(response, 404, ErrorCode.NOT_FOUND, `No such file: ${requested}`);
        }

        // The channel theme is the only asset here that is not text.
        const types = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.wav': 'audio/wav'
        };

        const type = types[extname(file)] || 'application/octet-stream';

        // A charset on a binary type is meaningless at best, so it is only
        // added for the types that are actually text.
        bytes(response, readFileSync(file), type.startsWith('text/') || type.endsWith('javascript')
            ? `${type}; charset=utf-8`
            : type);
    });

    // -------------------------------------------------------------- listen

    const server = createServer(router.listener);

    // A failed bind arrives as an event, not a throw, so without this the
    // service stays alive with nothing listening and the TV page polls a dead
    // port forever — which is exactly how the 8080 clash presented.
    server.on('error', (error) => {
        net.err(`cannot listen on ${PORT}: ${error.message}`);

        if (error.code === 'EADDRINUSE') {
            net.err('another app or a system service has claimed that port — nothing will answer');
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        net.ok(`listening on 0.0.0.0:${PORT}`);

        const addresses = lanAddresses();

        if (addresses.length === 0) {
            net.warn('no LAN address — this TV is not on a network, so no phone can reach it');
        }

        addresses.forEach((entry, index) => net.info(
            `${index === 0 ? 'reachable at' : 'also at'} http://${entry.address}:${PORT} (${entry.iface})`));

        // systemd's last startup line, and the most useful one it prints: it
        // turns "that felt slow" into a number.
        svc.ok(`startup finished in ${took(recorded.uptime())}`);
    });

    require('./socket.js').attach({ server, store, secret, authorise, installer, catalog, updates, relay, refreshDevice, config, protocol, log });

    return { server, port: PORT, pin: secret, build: BUILD };
};

// `onStart` is not a name of our choosing: it is the entry point Tizen's
// service runtime calls, and a service exporting anything else simply loads
// and then sits there — the app appears to run while nothing ever listens.
// Renaming it during a rewrite cost one broken deployment, so build.js now
// refuses to ship a bundle without it.
module.exports.onStart = start;
module.exports.start = start;

// `onRequest` is the other half of that same contract, and leaving it out was
// not free. Tizen's service runner calls it for every app control request
// delivered to a service that is *already* running — which is what the TV
// page's launchAppControl does every time somebody opens the app, on the
// second launch and every one after it. With nothing there to call, the runner
// threw
//
//     TypeError: app.onRequest is not a function
//         at MessagePort.<anonymous> (/usr/share/wrt/app/service/service_runner.js:152)
//
// into this process on every one of those launches. The service survived it —
// the process-wide handler in obs/log.js catches it — but it wrote a stack
// trace into the log each time, which is where it was eventually found:
// somebody had opened the app to read the log.
//
// There is nothing to do with the request. The service is already listening,
// and it carries nothing this one needs; saying so is the whole job. It is
// logged at debug because the page writes its own line for the launch, and two
// records for one event is how a log stops being read.
module.exports.onRequest = () => log.on(Facility.SVC).debug('a launch reached a service that is already running');
module.exports.BUILD = BUILD;
module.exports.PORT = PORT;

// On a TV the platform calls onStart(); off-TV this is a development harness.
if (!device.onTv) start();
