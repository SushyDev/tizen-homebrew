'use strict';

// Asking a television which device it is.
//
// Two ways in, and which one works depends on where the TV is in its life.
// Before it is pinned to loopback, sdbd answers this machine directly. After —
// which is the state a set spends its life in, and the point of the project —
// the only process still allowed to reach sdbd is Tizen Homebrew, running on
// the TV, so the question goes through its relay with the PIN from the screen.
//
// Both end at `shell:0 getduid`, which is the value Samsung binds a
// certificate to. Nothing else is the DUID: the device API on port 8001 serves
// a field called `duid` that is a different identifier entirely, and a
// certificate minted against it produces packages a television refuses with
// "Check certificate error" and no further explanation.

const sdb = require('../service/src/tv/sdb.js');

const PORT = 8091;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

/** Straight to sdbd, which only works while the TV points at this machine. */
const overSdb = async (ip) => {
    const session = await sdb.connect({ host: ip, timeout: 6000 });

    try {
        return await session.getDuid();
    } finally {
        session.close();
    }
};

/**
 * Through Tizen Homebrew on the television.
 *
 * The relay is off by default; this turns it on to ask and puts it back the
 * way it found it. That is a real escalation to perform on somebody's behalf,
 * which is why it needs a PIN — a person reading a code off the screen.
 */
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

/**
 * The DUID, by whichever route is open, or null.
 *
 * The relay is tried first when there is a PIN for it, because it works in the
 * state a television actually lives in.
 */
const duidOf = async (ip, pin) => {
    const relayed = pin ? await overRelay(ip, pin) : null;

    if (relayed) return relayed;

    return overSdb(ip).catch((error) => {
        // sdbd accepts the socket from any address and only then drops it when
        // the developer host IP is not ours. Once a TV is pinned to loopback
        // that is the expected outcome from a laptop, not a fault.
        if (['sdbRefused', 'sdbReset', 'sdbClosed', 'sdbTimeout'].indexOf(error.code) !== -1) return null;
        throw error;
    });
};

module.exports = { duidOf, overSdb, overRelay, PORT };
