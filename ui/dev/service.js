// A stand-in television for a browser: it speaks the real protocol over a real WebSocket, so the pages can be
// looked at without hardware.

import { createHash } from 'crypto';

// The real verdict table, so the failure shapes the UI renders come from the same place the service gets them.
import verdicts from '../../service/src/install/verdicts.js';

const PIN = '386588';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
    log.info('cat', '4 apps from the cache, 41m old');
};

const DEVICE = {
    onTv: true,
    ready: true,
    sdbReachable: true,
    platformVersion: '6.5',
    modelName: 'QN65Q80B',
    hasCertificates: true
};

// Drawn rather than fetched, and base64 because the markup contains `#` in every colour.
const artwork = (letter, top, bottom) => `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>` +
    '</linearGradient></defs>' +
    '<rect width="64" height="64" fill="url(#g)"/>' +
    '<text x="32" y="45" text-anchor="middle" fill="#ffffff" font-weight="700" ' +
    `font-size="36" font-family="Helvetica,Arial,sans-serif">${letter}</text></svg>`
).toString('base64')}`;

const CATALOG = [
    {
        id: 'homebrew',
        name: 'Tizen Homebrew',
        description: 'This app. Updates itself.',
        packageId: 'GJBBYNLkgP',
        icon: artwork('H', '#7fe3ff', '#0a5f80'),
        source: { type: 'github', ref: 'SushyDev/tizen-homebrew' }
    },
    {
        id: 'tube',
        name: 'YouTube',
        description: 'YouTube without the advertisements',
        icon: artwork('Y', '#ff4d4d', '#9b0000'),
        packageId: 'tUb3Xq7Lm9',
        source: { type: 'github', ref: 'SushyDev/tube' }
    },
    {
        id: 'jellyfin',
        name: 'Jellyfin',
        description: 'Your own media server, on the television',
        icon: artwork('J', '#aa5cd6', '#00a4dc'),
        packageId: 'AprZAcqzcc',
        source: { type: 'github', ref: 'jellyfin/jellyfin-tizen' }
    },
    {
        // Deliberately without artwork: a catalogue logo is guessed rather than declared, so a monogram row is
        // the ordinary case.
        id: 'kodi',
        name: 'Kodi',
        version: '21.0',
        description: 'The media centre, ported',
        source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' }
    }
];

const INSTALLED = { GJBBYNLkgP: '0.1.0', tUb3Xq7Lm9: '0.1.0' };

const RELEASED = { 'SushyDev/tizen-homebrew': '0.2.0', 'SushyDev/tube': '0.1.0' };

const listed = (checked) => CATALOG.map((app) => {
    const installed = INSTALLED[app.packageId] || null;

    const asked = app.source.type !== 'github' || checked.indexOf(app.id) !== -1;
    const available = app.source.type === 'github' ? RELEASED[app.source.ref] || null : app.version || null;

    return {
        ...app,
        version: (asked ? available : null) || app.version || null,
        installed,
        available: asked ? available : null,
        checked: asked,
        update: Boolean(asked && installed && available && available > installed)
    };
});

const PACKAGES = {
    '/media/usb1/YouTube.wgt': {
        packageId: 'tUb3Xq7Lm9', appId: 'tUb3Xq7Lm9.Tube', name: 'YouTube',
        version: '0.1.0', isWgt: true, icon: artwork('Y', '#ff4d4d', '#9b0000')
    },
    '/media/usb1/Jellyfin.wgt': {
        packageId: 'AprZAcqzcc', appId: 'AprZAcqzcc.Jellyfin', name: 'Jellyfin',
        version: '10.9.1', isWgt: true, icon: artwork('J', '#aa5cd6', '#00a4dc')
    },
    '/media/usb1/downloads/TizenHomebrew.wgt': {
        packageId: 'GJBBYNLkgP', appId: 'GJBBYNLkgP.TizenHomebrew', name: 'Tizen Homebrew',
        version: '0.1.0', isWgt: true, icon: null
    }
};

const onStick = (name, path, size) =>
    ({ name, path, isDirectory: false, size, identity: PACKAGES[path] || null });

const DIRECTORY = {
    '/media': [
        { name: '..', path: '/media', isDirectory: true },
        { name: 'usb1', path: '/media/usb1', isDirectory: true }
    ],
    '/media/usb1': [
        { name: '..', path: '/media', isDirectory: true },
        { name: 'downloads', path: '/media/usb1/downloads', isDirectory: true },
        onStick('YouTube.wgt', '/media/usb1/YouTube.wgt', 2528154),
        onStick('Jellyfin.wgt', '/media/usb1/Jellyfin.wgt', 8912896)
    ],
    '/media/usb1/downloads': [
        { name: '..', path: '/media/usb1', isDirectory: true },
        onStick('TizenHomebrew.wgt', '/media/usb1/downloads/TizenHomebrew.wgt', 58368)
    ]
};

const PHASES = [
    ['probing', null, 500],
    ['fetching', '2.4MB', 1600],
    ['resigning', null, 700],
    ['staging', 'over sdb', 1400],
    ['installing', null, 1100]
];

const accept = (key) => createHash('sha1').update(key + GUID).digest('base64');

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

const conversation = (socket, say) => {
    let paired = false;
    let relayEnabled = false;

    let checked = [];

    const send = (type, payload) => socket.write(frame(JSON.stringify({ type, payload })));

    const fail = (code, message, remedy) => send('error', { code, message, remedy: remedy || null, fatal: false });

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
                log.info('pkg', 'identified Tube 0.1.0 (tUb3Xq7Lm9, app tUb3Xq7Lm9.Tube, wgt)');
            },
            resigning: () => log.info('pkg', 'tizen 7 or newer — re-signing against this TV\'s own certificates'),
            staging: () => log.ok('pkg', 'staged 2.41 MB to /home/owner/share/tmp/sdk_tools/package.wgt'),
            installing: () => log.info('sdb', 'shell:0 vd_appinstall tUb3Xq7Lm9 /home/owner/share/tmp/sdk_tools/package.wgt')
        };

        const identity = PACKAGES[ref] || (() => {
            const entry = listed(checked).filter((app) => app.id === ref)[0];

            return entry
                ? {
                    packageId: entry.packageId || `${entry.id}Xq7Lm9`,
                    appId: `${entry.packageId || `${entry.id}Xq7Lm9`}.${entry.name.replace(/\s/g, '')}`,
                    name: entry.name,
                    version: entry.version,
                    isWgt: true,
                    icon: entry.icon || null
                }
                : { packageId: 'pKg4Tz1Wv8', appId: null, name: String(ref).split('/').pop(),
                    version: '1.0.0', isWgt: true, icon: null };
        })();

        for (const [phase, detail, wait] of PHASES) {
            // The real pipeline names the application in the re-signing phase rather than repeating the typed
            // reference.
            const announcing = phase === 'resigning';

            send('progress', {
                phase,
                detail: announcing ? identity.name : detail,
                identity: announcing ? identity : null
            });

            if (narrate[phase]) narrate[phase]();
            await new Promise((resolve) => setTimeout(resolve, wait));
        }

        if (String(ref).indexOf('fail') !== -1) {
            const refused = verdicts.failureIn(
                'app_id[tUb3Xq7Lm9] install failed[118, -11], reason: Author certificate not match :',
                { packageId: 'tUb3Xq7Lm9' }
            );

            log.err('pkg', `install failed after ${((Date.now() - began) / 1000).toFixed(2)}s: ` +
                `${refused.code} — ${refused.line}`);
            refused.remedy.split('\n').forEach((line) => log.warn('pkg', line));

            return fail(refused.code, refused.line, refused.remedy);
        }

        const entry = listed(checked).filter((app) => app.id === ref)[0];

        log.info('sdb', 'spend time for wgt injection: 4.19 sec');
        log.ok('sdb', 'vd_appinstall finished in 4.21s');
        log.ok('pkg', `installed ${entry ? entry.name : String(ref).split('/').pop()} ` +
            `${entry ? entry.version : '1.0.0'} in ${((Date.now() - began) / 1000).toFixed(2)}s`);

        send('done', {
            name: entry ? entry.name : String(ref).split('/').pop(),
            packageId: entry ? entry.packageId || `${entry.id}Xq7Lm9` : 'pKg4Tz1Wv8',
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
        getCatalog: () => send('catalog', { entries: listed(checked), stale: false }),

        checkUpdates: async ({ id }) => {
            const asking = CATALOG.filter((app) => app.source.type === 'github' && (!id || app.id === id));

            if (!asking.length) return send('catalog', { entries: listed(checked), stale: false });

            log.info('cat', `checking ${asking.length === 1 ? asking[0].name : `${asking.length} apps`} for a newer release`);

            await new Promise((resolve) => setTimeout(resolve, 400 * Math.ceil(asking.length / 3)));

            asking.forEach((app) => {
                if (checked.indexOf(app.id) === -1) checked.push(app.id);

                if (RELEASED[app.source.ref]) log.info('cat', `${app.source.ref} has released ${RELEASED[app.source.ref]}`);
                else log.warn('cat', `could not ask github about ${app.source.ref}: ` +
                    `${app.source.ref} has no published releases, or is private.`);
            });

            const marked = listed(checked);

            marked.filter((app) => app.update).forEach((app) =>
                log.ok('cat', `${app.name} ${app.installed} is installed and ${app.available} is out`));

            send('catalog', { entries: marked, stale: false });
        },
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

const ROUTES = {
    '/pin': () => ({ pin: PIN, port: 8091, addresses: ['192.168.2.9'], url: 'http://192.168.2.9:8091' }),
    '/state': () => DEVICE,
    '/health': () => ({ ok: true, port: 8091, onTv: true, addresses: ['192.168.2.9'] }),
    '/version': () => ({ build: 'dev', node: process.version, startedAt: new Date().toISOString(), uptimeSeconds: 1 }),
    '/packages': () => ({ ok: true, packages: Object.keys(INSTALLED).map((id) => ({ id, version: INSTALLED[id] })) }),
    '/logs': (query) => ({
        lines: lines.filter((line) => line.seq > (Number(query.get('since')) || 0)),
        uptime: Date.now() - startedAt
    })
};

// `enabled` is false whenever HOMEBREW_TV names a real device, in which case Vite proxies to it instead.
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

        // Vite's own HMR socket lives on the same server, so only /socket is claimed here.
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
