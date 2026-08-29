'use strict';

// sdbd accepts connections only from the configured developer host — 127.0.0.1, so the TV reaches itself.

const adb = require('./adb.js');

const SDB_PORT = 26101;
const DEFAULT_CONNECT_TIMEOUT = 8000;
const DEFAULT_EXEC_TIMEOUT = 120000;

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
            finish(SdbError('sdbStreamError', `SDB stream error: ${e}`), null);
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
Session.prototype.getDuid = function () {
    return this.exec('shell:0 getduid', { timeout: 10000, until: (o) => o.trim().length > 0 })
        .then((out) => out.trim());
};

Session.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    const stream = this._client && this._client._socket;
    if (!stream) return;
    stream.removeAllListeners('connect');
    stream.removeAllListeners('error');
    stream.removeAllListeners('close');
    try {
        stream.end();
        stream.destroy();
    } catch (e) { /* socket was already gone */ }
    this._client = null;
};

function connect(options) {
    const opts = options || {};
    const host = opts.host || '127.0.0.1';
    const timeout = opts.timeout || DEFAULT_CONNECT_TIMEOUT;

    return new Promise((resolve, reject) => {
        let client;
        try {
            client = adb.createConnection({ host, port: SDB_PORT });
        } catch (e) {
            return reject(SdbError('sdbRefused', `Could not create SDB connection: ${e.message}`));
        }

        const stream = client._socket;
        let settled = false;

        const timer = setTimeout(() => {
            finish(SdbError('sdbTimeout', `SDB did not answer on ${host}:${SDB_PORT} within ${timeout}ms.`), null);
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
                    `${host}:${SDB_PORT} refused the connection (ECONNREFUSED) — nothing is ` +
                    'listening. Developer Mode being off leaves sdbd unstarted, which looks like this.'), null);
            }

            if (code === 'ECONNRESET') {
                return finish(SdbError('sdbReset',
                    `${host}:${SDB_PORT} accepted the connection and then reset it (ECONNRESET). ` +
                    'sdbd resets a client whose address is not its developer host IP, and it also ' +
                    'drops connections intermittently under no particular provocation.'), null);
            }

            finish(SdbError('sdbError',
                `${host}:${SDB_PORT} connection error ${code}: ${(e && e.message) || e}`), null);
        }

        function onClose() {
            finish(SdbError('sdbClosed',
                `${host}:${SDB_PORT} closed the connection before the ADB handshake completed. ` +
                'sdbd does this to a client whose address is not its developer host IP, and ' +
                'intermittently to one whose address is.'), null);
        }

        // Resolve on the ADB handshake: sdbd accepts the socket first and resets it on a host mismatch.
        client.on('connect', onConnect);
        stream.on('error', onError);
        stream.on('close', onClose);
    });
}

function withSession(options, fn) {
    return connect(options).then((session) => {
        return Promise.resolve()
            .then(() => fn(session))
            .then(
                (value) => { session.close(); return value; },
                (err) => { session.close(); throw err; }
            );
    });
}

module.exports = { connect, withSession, Session, SdbError, SDB_PORT };
