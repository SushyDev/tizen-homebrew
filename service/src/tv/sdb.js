'use strict';

// sdbd accepts connections only from the configured developer host — 127.0.0.1, so the TV reaches itself.

const adb = require('./adb.js');

const SDB_PORT = 26101;
const DEFAULT_CONNECT_TIMEOUT = 8000;
const DEFAULT_EXEC_TIMEOUT = 120000;
const DEFAULT_ATTEMPTS = 3;
const RETRY_BACKOFF = 400;
const CLOSE_GRACE = 1000;
const IDLE_TIMEOUT = 30000;

// sdbd drops a connection mid-handshake, most often just after a previous one was torn down, and the
// command never ran — so a fresh socket is safe to try. A refusal is not that: nothing is listening.
const TRANSIENT = { sdbReset: true, sdbClosed: true };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A real DUID is one run of letters and digits; a failed read answers in prose, which must never
// reach a certificate's device id.
const LOOKS_LIKE_DUID = /^[A-Za-z0-9]{10,64}$/;
const DUID_ATTEMPTS = 3;

const INFOBUF_MAXLEN = 64;
const SYSINFO_PLATFORM_VERSION_FIELD = 3;

function SdbError(code, message) {
    const e = new Error(message);
    e.code = code;
    e.isSdbError = true;
    return e;
}

function Session(client) {
    this._client = client;
    this._closed = false;

    // Listeners go when the promise settles, so a later socket error would be unhandled — which in Node
    // is the process exiting. sdbd resets connections in ordinary use.
    const socket = client && client._socket;

    if (socket) {
        socket.on('error', (error) => { this._socketError = error; });
    }
}

// `until` finishes as soon as the output proves it worked: vd_appinstall keeps its stream open.
Session.prototype.exec = function (command, options) {
    const opts = options || {};
    const timeout = opts.timeout || DEFAULT_EXEC_TIMEOUT;
    const until = opts.until;
    const onChunk = opts.onData;
    const self = this;

    return new Promise((resolve, reject) => {
        if (self._closed) {
            return reject(SdbError('sdbClosed', 'SDB session is already closed.'));
        }

        let stream;
        try {
            stream = self._client.createStream(command);
        } catch (e) {
            return reject(SdbError('sdbStreamFailed', `Could not open SDB stream: ${e.message}`));
        }

        let output = '';
        let settled = false;

        const timer = setTimeout(() => {
            finish(SdbError('sdbTimeout', `Command timed out after ${timeout}ms: ${command}`), null);
        }, timeout);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener('data', onData);
            stream.removeListener('error', onError);
            stream.removeListener('end', onEnd);
            stream.removeListener('close', onEnd);
            // The connection outlives the command, so a command that stopped early gives its stream back.
            stream.close();
            if (err) reject(err); else resolve(value);
        }

        function onData(chunk) {
            const text = chunk.toString();
            output += text;
            if (onChunk) {
                try { onChunk(text); } catch (e) { /* ignore */ }
            }
            if (until && until(output)) finish(null, output);
        }

        function onError(e) {
            finish(SdbError('sdbStreamError', `SDB stream error: ${(e && e.message) || e}`), null);
        }

        if (self._socketError) {
            return finish(SdbError('sdbClosed', `SDB connection was lost: ${self._socketError.message}`), null);
        }

        function onEnd() {
            finish(null, output);
        }

        stream.on('data', onData);
        stream.on('error', onError);
        stream.on('end', onEnd);
        stream.on('close', onEnd);
    });
};

Session.prototype.platformVersion = function () {
    return new Promise((resolve, reject) => {
        let stream;
        try {
            stream = this._client.createStream('sysinfo:');
        } catch (e) {
            return reject(SdbError('sdbStreamFailed', `Could not open sysinfo stream: ${e.message}`));
        }

        let settled = false;
        const timer = setTimeout(() => finish(null, null), 5000);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener('data', onData);
            stream.close();
            if (err) reject(err); else resolve(value);
        }

        function onData(data) {
            const start = INFOBUF_MAXLEN * SYSINFO_PLATFORM_VERSION_FIELD;
            const end = INFOBUF_MAXLEN * (SYSINFO_PLATFORM_VERSION_FIELD + 1);
            const version = data.slice(start, end).toString().replace(/\0/g, '').trim();
            finish(null, version || null);
        }

        stream.on('data', onData);
    });
};

// `webapis.productinfo.getDuid()` is a different number; this is the one certificates are minted against.
Session.prototype.getDuid = function (options) {
    const opts = options || {};
    const attempts = Math.max(1, opts.attempts || DUID_ATTEMPTS);
    const self = this;

    // The whole line, not the first chunk of it: sdbd splits output where it likes, and half a DUID
    // still looks like a DUID.
    const ask = () => self
        .exec('shell:0 getduid', { timeout: 10000, until: (o) => o.indexOf('\n') !== -1 })
        .then((out) => String(out).split('\n')[0].trim());

    const attempt = (number) => ask().then((duid) => {
        if (LOOKS_LIKE_DUID.test(duid)) return duid;

        if (number >= attempts) {
            throw SdbError('sdbDuid',
                `\`getduid\` answered ${duid ? `'${duid}'` : 'nothing'}, which is not a device id.`);
        }

        return wait(RETRY_BACKOFF).then(() => attempt(number + 1));
    });

    return attempt(1);
};

// Whether this session can still carry a command, which is what decides if it gets reused.
Session.prototype.healthy = function () {
    if (this._closed || this._socketError) return false;

    const socket = this._client && this._client._socket;

    return !!(socket && socket.writable && !socket.destroyed);
};

Session.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;

    const client = this._client;
    const socket = client && client._socket;

    this._client = null;

    if (!socket) return;

    socket.removeAllListeners('connect');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    // Ending a half-dead socket can still raise EPIPE, and an unhandled one exits the process.
    socket.on('error', () => {});

    try {
        client.close();
    } catch (e) { /* socket was already gone */ }

    // The socket still has to go if sdbd never answers the FIN; a reset then is nobody's problem.
    const forced = setTimeout(() => {
        try {
            socket.destroy();
        } catch (e) { /* already gone */ }
    }, CLOSE_GRACE);

    if (forced.unref) forced.unref();

    socket.once('close', () => clearTimeout(forced));
};

function connectOnce(host, port, timeout, log) {
    return new Promise((resolve, reject) => {
        let client;
        try {
            client = adb.createConnection({ host, port, log });
        } catch (e) {
            return reject(SdbError('sdbRefused', `Could not create SDB connection: ${e.message}`));
        }

        const stream = client._socket;
        let settled = false;

        const timer = setTimeout(() => {
            finish(SdbError('sdbTimeout', `SDB did not answer on ${host}:${port} within ${timeout}ms.`), null);
        }, timeout);

        function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.removeListener('connect', onConnect);
            stream.removeListener('error', onError);
            stream.removeListener('close', onClose);
            if (err) {
                try { stream.destroy(); } catch (e) { /* already gone */ }
                reject(err);
            } else {
                resolve(value);
            }
        }

        function onConnect() {
            finish(null, new Session(client));
        }

        // What happened first, in the socket's own words; a cause after it, and only as a possibility.
        function onError(e) {
            const code = (e && e.code) || 'unknown';

            if (code === 'ECONNREFUSED') {
                return finish(SdbError('sdbRefused',
                    `${host}:${port} refused the connection (ECONNREFUSED) — nothing is ` +
                    'listening. Developer Mode being off leaves sdbd unstarted, which looks like this.'), null);
            }

            if (code === 'ECONNRESET') {
                return finish(SdbError('sdbReset',
                    `${host}:${port} accepted the connection and then reset it (ECONNRESET). ` +
                    'sdbd resets a client whose address is not its developer host IP, and it also ' +
                    'drops connections intermittently under no particular provocation.'), null);
            }

            if (code === 'ESDBFRAMING') {
                return finish(SdbError('sdbFraming', (e && e.message) || String(e)), null);
            }

            if (code === 'ESDBAUTH') {
                return finish(SdbError('sdbAuthRequired', (e && e.message) || String(e)), null);
            }

            finish(SdbError('sdbError',
                `${host}:${port} connection error ${code}: ${(e && e.message) || e}`), null);
        }

        function onClose() {
            finish(SdbError('sdbClosed',
                `${host}:${port} closed the connection before the ADB handshake completed. ` +
                'sdbd does this to a client whose address is not its developer host IP, and ' +
                'intermittently to one whose address is.'), null);
        }

        // Resolve on the ADB handshake: sdbd accepts the socket first and resets it on a host mismatch.
        client.on('connect', onConnect);
        stream.on('error', onError);
        stream.on('close', onClose);
    });
}

// The daemon's intermittent drops are what a second socket fixes; anything else fails on the first try.
function connect(options) {
    const opts = options || {};
    const host = opts.host || '127.0.0.1';
    const port = opts.port || SDB_PORT;
    const timeout = opts.timeout || DEFAULT_CONNECT_TIMEOUT;
    const attempts = Math.max(1, opts.attempts || DEFAULT_ATTEMPTS);
    const backoff = opts.backoff === undefined ? RETRY_BACKOFF : opts.backoff;
    const log = opts.log || function () {};

    const attempt = (number) => connectOnce(host, port, timeout, log).catch((error) => {
        if (number >= attempts || !TRANSIENT[error.code]) throw error;

        log(`sdb ${error.code} on attempt ${number} of ${attempts}; retrying on a fresh socket`);

        return wait(backoff * number).then(() => attempt(number + 1));
    });

    return attempt(1);
}

// Everything on the television shares one connection, the way sdb itself works: commands are streams
// over a single transport, and a new socket per command is what has sdbd resetting them.
let held = null;
let opening = null;
let inFlight = 0;
let idleTimer = null;

// A transport that failed — or one that stopped answering — is not trusted with the next command, so
// the call after it reconnects.
const DROPPED = {
    sdbClosed: true, sdbReset: true, sdbError: true, sdbFraming: true,
    sdbAuthRequired: true, sdbStreamError: true, sdbTimeout: true
};

function release() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    // A connection still being made is released as soon as it arrives, so nothing outlives a shutdown
    // and gets reset by the process exiting under it.
    if (opening) opening.then((session) => session.close(), () => {});

    const session = held;

    held = null;

    if (session) session.close();
}

// An unused connection is given up rather than held all evening, which is also what sdb does.
function watchIdle() {
    if (idleTimer) clearTimeout(idleTimer);

    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (inFlight === 0) release();
    }, IDLE_TIMEOUT);

    if (idleTimer.unref) idleTimer.unref();
}

function acquire(options) {
    if (held && !held.healthy()) release();
    if (held) return Promise.resolve(held);
    if (opening) return opening;

    opening = connect(options).then(
        (session) => { held = session; opening = null; return session; },
        (error) => { opening = null; throw error; }
    );

    return opening;
}

function withSession(options, fn) {
    return acquire(options).then((session) => {
        inFlight++;

        const settled = (error) => {
            inFlight--;

            if (error && DROPPED[error.code] && inFlight === 0) release();
            else watchIdle();
        };

        return Promise.resolve()
            .then(() => fn(session))
            .then(
                (value) => { settled(null); return value; },
                (error) => { settled(error); throw error; }
            );
    });
}

module.exports = { connect, withSession, release, Session, SdbError, SDB_PORT };
