// A television, for people who do not have one to hand.
//
// The pages this repo ships are useless in a browser without a service behind
// them: the phone UI shows a PIN box and nothing else until something answers
// the socket, and the TV screen sits on "starting background service" forever.
// That made the design impossible to *look at* without a Samsung TV on the
// desk, which is the reason the first version of it shipped badly.
//
// So with no `HOMEBREW_TV` set, this answers instead. It speaks the real
// protocol over a real WebSocket — `src/core/socket.js` runs unmodified
// against it, reconnects and all — and it walks an install through its five
// phases on a timer so the progress states can actually be watched.
//
// It is a Vite plugin and it is `apply: 'serve'`. None of it can reach a
// build.

import { createHash } from 'crypto';

// The pairing code the fake TV is showing. Fixed rather than random, because
// the point is to get to the interface quickly and often.
const PIN = '386588';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── The log ──────────────────────────────────────────────────────────────
//
// The TV screen's console is fed by `GET /logs`, so a stand-in that answers it
// with an empty list makes the one screen this repo added last impossible to
// look at without a television. This keeps the real service's record shape —
// `{ seq, t, at, level, facility, text }` — and writes the same lines it
// would: a boot sequence at startup, then whatever the browser actually does.

const startedAt = Date.now();
const lines = [];
let sequence = 0;

const write = (level, facility, text) => {
    lines.push({
        seq: ++sequence,
        t: Date.now() - startedAt,
        at: new Date().toISOString(),
        level,
        facility,
        text
    });

    while (lines.length > 1000) lines.shift();
};

const log = ['debug', 'info', 'ok', 'warn', 'err'].reduce((writers, level) => ({
    ...writers,
    [level]: (facility, text) => write(level, facility, text)
}), {});

// What a real service says between being started and being ready. The timings
// are not padded: this is what one of these logs looks like.
const boot = () => {
    log.info('svc', 'tizen homebrew dev starting');
    log.info('svc', `node ${process.version} on ${process.platform}/${process.arch}, pid ${process.pid}`);
    log.info('auth', `pairing pin ${PIN} — regenerated every start`);
    log.info('cat', 'origin https://cdn.example.com/homebrew/catalog.json');
    log.info('cfg', 'cache /home/owner/share/homebrewCatalog.json');
    log.info('svc', 'serving the phone UI from /opt/usr/apps/GJBBYNLkgP/res/wgt/ui/dist');
    log.ok('net', 'listening on 0.0.0.0:8091');
    log.info('net', 'reachable at http://192.168.2.9:8091 (eth0)');
    log.ok('svc', 'startup finished in 312ms');
    log.info('dev', 'tizen 6.5');
    log.ok('sdb', 'loopback 127.0.0.1:26101 answered — this TV can install its own apps');
    log.info('cat', '3 apps from the cache, 41m old');
};

// ── The device, and what it has to offer ─────────────────────────────────

const DEVICE = {
    onTv: true,
    ready: true,
    sdbReachable: true,
    platformVersion: '6.5',
    modelName: 'QN65Q80B',
    hasCertificates: true
};

const CATALOG = [
    {
        id: 'tube',
        name: 'YouTube',
        version: '0.1.0',
        description: 'YouTube without the advertisements',
        source: { type: 'github', ref: 'SushyDev/tube' }
    },
    {
        id: 'jellyfin',
        name: 'Jellyfin',
        version: '10.9.1',
        description: 'Your own media server, on the television',
        source: { type: 'github', ref: 'jellyfin/jellyfin-tizen' }
    },
    {
        id: 'kodi',
        name: 'Kodi',
        version: '21.0',
        description: 'The media centre, ported',
        source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' }
    }
];

const DIRECTORY = {
    '/media': [
        { name: '..', path: '/media', isDirectory: true },
        { name: 'usb1', path: '/media/usb1', isDirectory: true }
    ],
    '/media/usb1': [
        { name: '..', path: '/media', isDirectory: true },
        { name: 'downloads', path: '/media/usb1/downloads', isDirectory: true },
        { name: 'YouTube.wgt', path: '/media/usb1/YouTube.wgt', isDirectory: false },
        { name: 'Jellyfin.wgt', path: '/media/usb1/Jellyfin.wgt', isDirectory: false }
    ],
    '/media/usb1/downloads': [
        { name: '..', path: '/media/usb1', isDirectory: true },
        { name: 'TizenHomebrew.wgt', path: '/media/usb1/downloads/TizenHomebrew.wgt', isDirectory: false }
    ]
};

// The install pipeline, at a speed a person can watch. The real one is
// dominated by the download and the copy, which is why those two are given
// most of the time here.
const PHASES = [
    ['probing', null, 500],
    ['fetching', '2.4MB', 1600],
    ['resigning', null, 700],
    ['staging', 'over sdb', 1400],
    ['installing', null, 1100]
];

// ── WebSocket, from the handshake up ─────────────────────────────────────
//
// About seventy lines, and worth every one of them: the alternative is a fake
// transport inside the page, which would leave `core/socket.js` — the file
// most likely to be wrong — the one file never exercised in development.
//
// Only what this needs is implemented: text frames out, text frames in, and a
// close. No fragmentation, no compression, no ping.

const accept = (key) => createHash('sha1').update(key + GUID).digest('base64');

/** Wraps a string as a single unfragmented text frame. */
const frame = (text) => {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;

    const header = length < 126 ? Buffer.from([0x81, length])
        : length < 65536 ? Buffer.from([0x81, 126, length >> 8 & 0xff, length & 0xff])
            : Buffer.concat([
                Buffer.from([0x81, 127, 0, 0, 0, 0]),
                Buffer.from([length >> 24 & 0xff, length >> 16 & 0xff, length >> 8 & 0xff, length & 0xff])
            ]);

    return Buffer.concat([header, payload]);
};

/**
 * Pulls whole frames out of a buffer.
 *
 * Returns the messages it could complete and whatever bytes are left over, so
 * the caller can hand them back with the next chunk — a message split across
 * two TCP reads is the normal case, not an edge one.
 */
const unframe = (buffer) => {
    const messages = [];
    let offset = 0;

    for (;;) {
        if (buffer.length - offset < 2) break;

        const opcode = buffer[offset] & 0x0f;
        const masked = (buffer[offset + 1] & 0x80) !== 0;
        let length = buffer[offset + 1] & 0x7f;
        let cursor = offset + 2;

        if (length === 126) {
            if (buffer.length < cursor + 2) break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        } else if (length === 127) {
            if (buffer.length < cursor + 8) break;
            length = Number(buffer.readBigUInt64BE(cursor));
            cursor += 8;
        }

        const mask = masked ? buffer.slice(cursor, cursor + 4) : null;
        if (masked) cursor += 4;

        if (buffer.length < cursor + length) break;

        const payload = Buffer.from(buffer.slice(cursor, cursor + length));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

        offset = cursor + length;

        if (opcode === 0x08) return { messages, rest: buffer.slice(offset), closed: true };
        if (opcode === 0x01) messages.push(payload.toString('utf8'));
    }

    return { messages, rest: buffer.slice(offset), closed: false };
};

// ── The conversation ─────────────────────────────────────────────────────

const conversation = (socket, say) => {
    let paired = false;
    let relayEnabled = false;

    const send = (type, payload) => socket.write(frame(JSON.stringify({ type, payload })));

    const fail = (code, message) => send('error', { code, message, fatal: false });

    /** Walks one install through its phases, then succeeds or refuses. */
    const install = async ({ source, ref }) => {
        const began = Date.now();

        log.info('sock', `192.168.2.31 asked to install ${source} ${ref}`);
        log.info('pkg', `install requested: ${source} ${ref}`);

        const narrate = {
            probing: () => log.info('pkg', 'television is tizen 6.5, sdb reachable'),
            fetching: () => {
                log.info('pkg', `asking github for the latest release of ${ref}`);
                log.info('pkg', 'release v0.1.4 carries tube.wgt (2.41 MB)');
                log.ok('pkg', 'got tube.wgt: 2.41 MB in 1.60s (1.51 MB/s)');
                log.info('pkg', 'sha256 3f2a91c0d84b17e6…');
            },
            resigning: () => log.info('pkg', 'tizen 7 or newer — re-signing against this TV\'s own certificates'),
            staging: () => {
                log.info('pkg', 'identified Tube 0.1.0 (tUb3Xq7Lm9, app tUb3Xq7Lm9.Tube, wgt)');
                log.ok('pkg', 'staged 2.41 MB to /home/owner/share/tmp/sdk_tools/package.wgt');
            },
            installing: () => log.info('sdb', 'shell:0 vd_appinstall tUb3Xq7Lm9 /home/owner/share/tmp/sdk_tools/package.wgt')
        };

        for (const [phase, detail, wait] of PHASES) {
            send('progress', { phase, detail });
            if (narrate[phase]) narrate[phase]();
            await new Promise((resolve) => setTimeout(resolve, wait));
        }

        // One source always refuses, because the failure states need looking
        // at as much as the happy one does.
        if (String(ref).indexOf('fail') !== -1) {
            log.err('pkg', `install failed after ${((Date.now() - began) / 1000).toFixed(2)}s: installFailed — app install failed[118, -14]`);
            return fail('installFailed', 'app install failed[118, -14]');
        }

        const entry = CATALOG.filter((app) => app.id === ref)[0];

        log.info('sdb', 'spend time for wgt injection: 4.19 sec');
        log.ok('sdb', 'vd_appinstall finished in 4.21s');
        log.ok('pkg', `installed ${entry ? entry.name : String(ref).split('/').pop()} ` +
            `${entry ? entry.version : '1.0.0'} in ${((Date.now() - began) / 1000).toFixed(2)}s`);

        send('done', {
            name: entry ? entry.name : String(ref).split('/').pop(),
            packageId: entry ? `${entry.id}Xq7Lm9` : 'pKg4Tz1Wv8',
            version: entry ? entry.version : '1.0.0',
            source
        });
    };

    const relay = async ({ id, command }) => {
        log.info('relay', `exec ${command.trim()}`);

        const answers = {
            'pkgcmd -l': 'Total 3 packages\npkg [wgt]\tpkgid [GJBBYNLkgP]\tapp [TizenHomebrew]\n' +
                         'pkg [wgt]\tpkgid [tUb3Xq7Lm9]\tapp [Tube]\npkg [tpk]\tpkgid [org.tizen.browser]\n',
            'uname -a': 'Linux localhost 4.19.221 #1 SMP PREEMPT armv7l GNU/Linux\n'
        };

        const output = answers[command.trim()] || `sh: ${command.trim()}: not found\n`;

        // Streamed a line at a time, because the real one is and the UI has
        // to look right while it arrives.
        for (const line of output.split('\n').filter(Boolean)) {
            send('relayData', { id, chunk: `${line}\n` });
            await new Promise((resolve) => setTimeout(resolve, 90));
        }

        send('relayEnd', { id, output, truncated: false, timedOut: false });
    };

    const handlers = {
        hello: ({ pin }) => {
            if (pin !== PIN) {
                say(`rejected PIN ${pin}`);
                log.warn('auth', '192.168.2.31 gave the wrong PIN');
                return send('hello', { ok: false, needsPin: true });
            }

            paired = true;
            say('paired');
            log.ok('auth', '192.168.2.31 paired');
            send('hello', { ok: true, needsPin: false });
            send('relayState', { enabled: relayEnabled });
            send('state', DEVICE);
        },

        getState: () => send('state', DEVICE),
        getCatalog: () => send('catalog', { entries: CATALOG, stale: false }),
        listDir: ({ path }) => send('dir', DIRECTORY[path] || DIRECTORY['/media']),
        install,

        setRelay: ({ enabled }) => {
            relayEnabled = !!enabled;
            log.warn('sock', `192.168.2.31 turned the command relay ${enabled ? 'on' : 'off'}`);
            send('relayState', { enabled: relayEnabled });
        },

        relayExec: (payload) => (relayEnabled
            ? relay(payload)
            : fail('relayDisabled', 'The command relay is turned off.'))
    };

    // The service greets every connection by asking for a PIN.
    send('hello', { ok: false, needsPin: true });

    return async (raw) => {
        const message = (() => {
            try {
                return JSON.parse(raw);
            } catch (e) {
                return null;
            }
        })();

        if (!message || !handlers[message.type]) return fail('badMessage', 'Unknown message.');

        if (!paired && message.type !== 'hello') {
            return fail('unauthorized', 'Enter the PIN shown on the TV first.');
        }

        try {
            await handlers[message.type](message.payload || {});
        } catch (error) {
            fail('internal', error.message);
        }
    };
};

// ── The plugin ───────────────────────────────────────────────────────────

const ROUTES = {
    '/pin': () => ({ pin: PIN, port: 8091, addresses: ['192.168.2.9'], url: 'http://192.168.2.9:8091' }),
    '/state': () => DEVICE,
    '/health': () => ({ ok: true, port: 8091, onTv: true, addresses: ['192.168.2.9'] }),
    '/version': () => ({ build: 'dev', node: process.version, startedAt: new Date().toISOString(), uptimeSeconds: 1 }),
    '/packages': () => ({ ok: true, packages: [{ id: 'GJBBYNLkgP', name: 'Tizen Homebrew', version: '0.1.0' }] }),
    // `uptime` comes with the lines because the page stamps its own events on
    // this service's clock — see the note on /logs in the real one.
    '/logs': (query) => ({
        lines: lines.filter((line) => line.seq > (Number(query.get('since')) || 0)),
        uptime: Date.now() - startedAt
    })
};

/**
 * Serves a stand-in for the on-TV service.
 *
 * `enabled` is false whenever HOMEBREW_TV names a real device, in which case
 * Vite proxies to it instead and none of this is installed.
 */
const devService = ({ enabled }) => ({
    name: 'tizen-homebrew-dev-service',
    apply: 'serve',

    configureServer(server) {
        if (!enabled) return;

        const say = (message) => server.config.logger.info(`  [36mtv[0m  ${message}`);

        server.middlewares.use((request, response, next) => {
            const path = request.url.split('?')[0];
            const route = ROUTES[path];

            if (!route) return next();

            response.setHeader('content-type', 'application/json; charset=utf-8');
            response.setHeader('access-control-allow-origin', '*');
            response.end(JSON.stringify(route(new URLSearchParams(request.url.split('?')[1] || ''))));
        });

        // Vite's own HMR socket lives on the same server, so only /socket is
        // claimed here and everything else is left alone.
        server.httpServer.on('upgrade', (request, socket) => {
            if (request.url.split('?')[0] !== '/socket') return;

            const key = request.headers['sec-websocket-key'];
            if (!key) return socket.destroy();

            socket.write([
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${accept(key)}`,
                '', ''
            ].join('\r\n'));

            say('a client connected');
            log.info('sock', '192.168.2.31 connected (1 client)');

            const handle = conversation(socket, say);
            let pending = Buffer.alloc(0);

            socket.on('data', (chunk) => {
                pending = Buffer.concat([pending, chunk]);

                const { messages, rest, closed } = unframe(pending);
                pending = rest;

                messages.forEach(handle);
                if (closed) socket.end();
            });

            socket.on('close', () => log.info('sock', '192.168.2.31 disconnected normally (0 clients)'));
            socket.on('error', () => socket.destroy());
        });

        server.httpServer.once('listening', () => {
            boot();
            say(`answering as a Samsung TV — pairing code ${PIN}`);
        });
    }
});

export { devService, PIN };
