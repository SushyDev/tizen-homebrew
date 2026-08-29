'use strict';

const { networkInterfaces } = require('os');

const sdb = require('../service/src/tv/sdb.js');

const PORT = 8091;

const DEVICE_API_PORT = 8001;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

// Both routes end at `shell:0 getduid`, which is the value Samsung binds a certificate to.
const overSdb = async (ip) => {
    const session = await sdb.connect({ host: ip, timeout: 6000 });

    try {
        return await session.getDuid();
    } finally {
        session.close();
    }
};

// The relay is off by default; this turns it on to ask and puts it back. That is a real escalation
// on somebody's behalf, which is why it needs a PIN read off the screen.
const overRelay = (ip, pin) => new Promise((resolve, reject) => {
    const WebSocket = require('ws');

    const socket = new WebSocket(`ws://${ip}:${PORT}`);
    const send = (type, payload) => socket.send(JSON.stringify({ type, payload: payload || {} }));

    const finish = (error, value) => {
        try {
            socket.close();
        } catch (e) { /* already gone */ }

        if (error) reject(error); else resolve(value);
    };

    const deadline = setTimeout(
        () => finish(friendly(`Tizen Homebrew did not answer on ${ip}:${PORT}.`)),
        25000
    );

    let greeted = false;
    let asked = false;

    socket.on('message', (raw) => {
        const { type, payload } = JSON.parse(raw);

        if (type === 'hello' && !greeted) {
            greeted = true;
            return send('hello', { pin });
        }

        if (type === 'hello' && !payload.ok) {
            clearTimeout(deadline);
            return finish(friendly('That PIN was refused. It changes every time the service starts — check the TV screen.'));
        }

        if (type === 'relayState' && !payload.enabled && !asked) return send('setRelay', { enabled: true });

        if (type === 'relayState' && payload.enabled && !asked) {
            asked = true;
            return send('relayExec', { id: 'duid', command: 'getduid' });
        }

        if (type === 'relayEnd') {
            clearTimeout(deadline);
            send('setRelay', { enabled: false });

            return setTimeout(() => finish(null, String(payload.output || '').trim() || null), 400);
        }

        if (type === 'error') {
            clearTimeout(deadline);
            return finish(friendly(`Tizen Homebrew refused: ${payload.message}`));
        }
    });

    socket.on('error', (error) => {
        clearTimeout(deadline);
        finish(friendly(
            `Could not reach Tizen Homebrew at ${ip}:${PORT} — ${error.message}\n\n` +
            '  Open Tizen Homebrew on the TV; the service only runs while it is open.'
        ));
    });
});

const duidOf = async (ip, pin) => {
    const relayed = pin ? await overRelay(ip, pin) : null;

    if (relayed) return relayed;

    return overSdb(ip).catch((error) => {
        if (['sdbRefused', 'sdbReset', 'sdbClosed', 'sdbTimeout'].indexOf(error.code) !== -1) return null;
        throw error;
    });
};

const describe = async (ip) => {
    try {
        const response = await fetch(`http://${ip}:${DEVICE_API_PORT}/api/v2/`, {
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) return null;

        const { device } = await response.json();
        return device || null;
    } catch (e) {
        return null;
    }
};

const localAddressFor = (tvIp) => {
    const prefix = `${tvIp.split('.').slice(0, 3).join('.')}.`;
    const interfaces = networkInterfaces();
    let fallback = null;

    for (const name in interfaces) {
        for (const entry of interfaces[name] || []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (entry.address.indexOf(prefix) === 0) return entry.address;
            if (!fallback) fallback = entry.address;
        }
    }

    return fallback;
};

const whyNoDuid = (ip, pin) => `${ip} did not answer with a device id.\n\n` + (pin
    ? '  The PIN goes through Tizen Homebrew, so the app has to be open on the TV —\n' +
      '  the service only runs while it is. The PIN changes every time it starts, so\n' +
      '  take the one on the screen now.'
    : '  That was asked over sdb, so sdbd is not accepting this machine. On the TV:\n' +
      '  Apps > 12345 (or hold Enter) > Settings, set\n\n' +
      `    Host PC IP  =  ${localAddressFor(ip) || '<this machine\'s IP>'}\n\n` +
      '  and restart it — that value is only read at startup.\n\n' +
      '  Or, if this set is already pinned to 127.0.0.1, read the code off its screen\n' +
      '  and the question goes through Tizen Homebrew instead.');

module.exports = { duidOf, overSdb, overRelay, describe, localAddressFor, whyNoDuid, PORT, DEVICE_API_PORT };
