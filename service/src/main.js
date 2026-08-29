'use strict';

const { createServer } = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, normalize } = require('path');
const { homedir } = require('os');

const { startRecording, Facility } = require('./obs/log.js');
const { size, took, host } = require('./obs/units.js');
const runtime = require('./obs/runtime.js');
const platform = require('./obs/platform.js');
const memory = require('./obs/memory.js');

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

// 8080 is taken by a Samsung system service, so binding there fails with EADDRINUSE.
const PORT = Number(process.env.HOMEBREW_PORT) || 8091;

const BUILD = '__HOMEBREW_BUILD__';
const ORIGIN = '__HOMEBREW_ORIGIN__';

const DEVELOPER = globalThis.__HOMEBREW_DEV__ === true;

const start = () => {
    const startedAt = new Date().toISOString();
    const secret = DEVELOPER ? pin.DEVELOPER_PIN : pin.generate();

    const svc = log.on(Facility.SVC);
    const net = log.on(Facility.NET);
    const dev = log.on(Facility.DEV);

    svc.info(`tizen homebrew ${BUILD} starting`);
    svc.info(`${runtime.summary()}, pid ${process.pid}`);

    platform.describe().then(
        (facts) => platform.summary(facts).forEach((line) => dev.info(line)),
        (error) => dev.warn(`could not read the platform: ${error.message}`)
    );

    if (DEVELOPER) {
        log.on(Facility.AUTH).warn(`DEVELOPER BUILD — pin fixed at ${secret}, and POST /dev/eval will run ` +
            'anything this network sends it. Do not leave this on a television you care about.');
    } else {
        log.on(Facility.AUTH).info(`pairing pin ${secret} — regenerated every start`);
    }

    const adopted = config.adoptHandoff();

    if (adopted) {
        log.on(Facility.CFG).ok(`certificates adopted from bootstrap for ${adopted.join(', ') || 'an unnamed device'}`);
    } else if (config.hasLegacyCertificates()) {
        log.on(Facility.CFG).warn('the stored certificates are in the old .p12 format and cannot be used — ' +
            'run `npm run certs` again');
    }

    const store = createStore({
        installing: false,
        catalog: [],
        catalogStale: false,
        lockout: pin.fresh(),
        device: null
    });

    const stored = config.read().catalogUrl;
    const catalogUrl = stored || `${ORIGIN}/catalog.json`;
    const catalogCache = join(homedir(), 'share', 'homebrewCatalog.json');

    const catalog = createCatalog({ url: catalogUrl, cachePath: catalogCache, log });

    // No prime() at startup: priming getPackagesInfo wedges the service on Tizen 9.0.
    const updates = createUpdates({ packages, log, config });

    log.on(Facility.CAT).info(`origin ${catalogUrl}${stored ? ' (from the stored configuration)' : ''}`);
    log.on(Facility.CFG).info(`cache ${catalogCache}`);

    const relay = new Relay({
        enabled: config.read().relayEnabled,
        packageId: device.onTv ? tizen.application.getAppInfo().packageId : null,
        log: (message) => log.on(Facility.RELAY).info(message)
    });

    if (relay.enabled) log.on(Facility.RELAY).warn('the command relay is ON from stored configuration');

    // Loaded on first use so a television that never installs anything does not parse node-forge.
    const resigner = async () => {
        const { resign } = require('./install/resign.js');

        return (archive) => resign(archive, config.read());
    };

    const installer = createInstaller({ sdb, device, config, resigner, store, log });

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
            log.on(Facility.SDB).warn(state.sdbDetail
                ? `loopback 127.0.0.1:${sdb.SDB_PORT} — ${state.sdbDetail}`
                : `loopback 127.0.0.1:${sdb.SDB_PORT} is not usable (${state.sdbError || state.reason || 'unknown'})`);

            dev.info(state.reason === 'debugModeOff'
                ? 'if it stays this way: Developer Mode in Apps › 12345 › Settings, then restart the TV'
                : 'if it stays this way: Host PC IP = 127.0.0.1 in Apps › 12345 › Settings, then restart ' +
                  'the TV — sdbd reads that value only at startup');
        }

        return state;
    };

    const refreshDevice = async () => {
        const previous = store.select('device');
        const first = await device.probe();

        // sdbd drops the occasional connection, so a demotion is confirmed by a second probe.
        const state = previous && previous.ready && !first.ready
            ? await device.probe()
            : first;

        store.update({ device: state });

        return announce(state, previous);
    };

    refreshDevice();
    if (device.onTv) setInterval(refreshDevice, 15000);

    const fromLoopback = (request) => {
        const address = (request.socket && request.socket.remoteAddress) || '';
        return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    };

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

    const lanAddresses = () => {
        const interfaces = require('os').networkInterfaces();
        const wiredFirst = (name) => (/^(eth|en)/.test(name) ? 0 : /^(wlan|wl)/.test(name) ? 1 : 2);

        return Object.entries(interfaces)
            .flatMap(([name, entries]) => (entries || [])
                .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
                .map((entry) => ({ address: entry.address, iface: name })))
            .sort((a, b) => wiredFirst(a.iface) - wiredFirst(b.iface));
    };

    // The TV's own page polls these several times a second, so they are logged at debug.
    const POLLED = ['/logs', '/state', '/pin', '/version', '/health'];

    const quiet = (request, path) =>
        request.method === 'GET' && fromLoopback(request) && POLLED.indexOf(path) !== -1;

    const router = createRouter({ log, quiet });

    router.on.get('/version', (_request, response) => json(response, {
        build: BUILD,
        node: process.version,
        runtime: runtime.describe(),

        startedAt,
        uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),

        // The gap between the two is the only visible sign that Tizen reloaded the service.
        processUptimeSeconds: Math.round(process.uptime())
    }));

    router.on.get('/health', (_request, response) => json(response, {
        ok: true,
        port: PORT,
        onTv: device.onTv,
        addresses: lanAddresses().map((entry) => entry.address)
    }));

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

    // Served from the last sweep: probing here made the set connect to its own sdbd twelve times a minute.
    router.on.get('/state', (request, response) => {
        if (!fromLoopback(request)) {
            return failure(response, 403, ErrorCode.UNAUTHORIZED, 'Only readable from the TV itself.');
        }

        json(response, store.select('device') || {});
    });

    const authorisedRead = (request, response, handle) => {
        if (fromLoopback(request)) return handle();

        const verdict = authorise(request.headers['x-homebrew-pin']);
        if (!verdict.ok) return failure(response, 403, verdict.code, verdict.message);

        return handle();
    };

    router.on.get('/logs', (request, response, { query }) =>
        authorisedRead(request, response, () =>
            json(response, { lines: recorded.since(query.get('since')), uptime: recorded.uptime() })));

    router.on.get('/packages', (request, response) =>
        authorisedRead(request, response, () =>
            packages.list().then(
                (list) => json(response, { ok: true, packages: list }),
                (error) => failure(response, 500, error.code || ErrorCode.INTERNAL, error.message))));

    if (DEVELOPER) {
        const { createRepl } = require('./dev/repl.js');

        const repl = createRepl({
            require, process, log, store, config, secret,
            catalog, updates, installer, relay, device, sdb, packages, platform, runtime, memory
        });

        const gate = (request, response) => {
            const verdict = authorise(request.headers['x-homebrew-pin']);
            if (verdict.ok) return true;
            failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
            return false;
        };

        svc.warn(`repl: POST /dev/eval, with ${repl.names.join(' ')} in scope`);

        router.on.post('/dev/eval', async (request, response) => {
            if (!gate(request, response)) return;

            const source = (await readBody(request, 64 * 1024)).toString('utf8');

            svc.warn(`eval from ${host(request.socket && request.socket.remoteAddress)}: ` +
                source.replace(/\s+/g, ' ').slice(0, 200));

            json(response, await repl.evaluate(source));
        });

        router.on.post('/dev/inspect', (request, response) => {
            if (!gate(request, response)) return;

            const opened = repl.openInspector(Number(request.headers['x-homebrew-port']) || 9229);

            svc.warn(`inspector: ${opened.ok ? `open at ${opened.url}` : opened.error}`);
            json(response, opened);
        });
    }

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

            updates.changed();

            json(response, { ok: true, phases, ...outcome });
        } catch (error) {
            failure(response, 500, error.code || ErrorCode.INTERNAL, error.message, error.remedy);
            log.on(Facility.PKG).err(`upload install stopped after: ${phases.join(', ') || 'nothing'}`);
        }
    });

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

        const devices = ((pair || {}).devices || []).filter((name) => typeof name === 'string' && name);

        const opened = (() => {
            try {
                return require('./install/resign.js').openPair(pair);
            } catch (error) {
                return { error };
            }
        })();

        if (opened.error) {
            return failure(response, 400, ErrorCode.BAD_MESSAGE, opened.error.message);
        }

        const device = devices[0] || null;
        const state = store.select('device');
        const here = state && state.duid;

        config.update({
            author: pair.author,
            distributor: pair.distributor,
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

    // Exiting is all the service can do about its own lifetime: nothing respawns it, and the UI page
    // holds no privilege to stop a sibling application.
    const exitAfterResponse = (payload, asked, why) => (request, response) => {
        const verdict = authorise(request.headers['x-homebrew-pin']);

        if (!verdict.ok) {
            return failure(response, verdict.code === ErrorCode.LOCKED_OUT ? 429 : 403, verdict.code, verdict.message);
        }

        json(response, { ok: true, build: BUILD, ...payload });

        svc.warn(`${host(request.socket && request.socket.remoteAddress)} asked the service to ${asked}`);

        // The response has to clear the socket first, because the caller waits on it.
        setTimeout(() => {
            svc.info(`exiting after ${took(recorded.uptime())} ${why}`);
            process.exit(0);
        }, 300);
    };

    router.on.post('/restart', exitAfterResponse(
        { restarting: true }, 'restart', 'so the platform reloads it on new code'));

    router.on.post('/shutdown', exitAfterResponse(
        { stopping: true }, 'stop', 'because the television app is closing'));

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

        // Confirms the collapsed path is still inside the UI directory — this would serve any file on the TV.
        if (!file.startsWith(uiRoot) || !existsSync(file)) {
            return failure(response, 404, ErrorCode.NOT_FOUND, `No such file: ${requested}`);
        }

        const types = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.wav': 'audio/wav'
        };

        const type = types[extname(file)] || 'application/octet-stream';

        bytes(response, readFileSync(file), type.startsWith('text/') || type.endsWith('javascript')
            ? `${type}; charset=utf-8`
            : type);
    });

    const server = createServer(router.listener);

    // A failed bind arrives as an event, so without this nothing listens and nothing says so.
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

        svc.ok(`startup finished in ${took(recorded.uptime())}`);

    });

    require('./socket.js').attach({ server, store, secret, authorise, installer, catalog, updates, relay, refreshDevice, config, protocol, log });

    return { server, port: PORT, pin: secret, build: BUILD };
};

// Tizen's service runtime calls onStart; a service exporting anything else loads and never listens.
module.exports.onStart = start;
module.exports.start = start;

// Tizen calls onRequest for launches into a running service; without it the runner throws on each one.
module.exports.onRequest = () => log.on(Facility.SVC).debug('a launch reached a service that is already running');
module.exports.BUILD = BUILD;
module.exports.PORT = PORT;

if (!device.onTv) start();
