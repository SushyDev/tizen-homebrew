'use strict';

// Promisified wrapper around the TV's own SDB daemon.
//
// Enabling Developer Mode starts sdbd on port 26101, and it accepts
// connections only from the IP configured as the developer host. When that is
// set to 127.0.0.1 the TV accepts connections from itself, so this service can
// drive installs with no external machine involved.
//
// The reference implementation (TizenBrewInstaller index.js:69) leaked
// listeners between attempts, resolved off a bare 1s timer, and could settle
// its promise more than once. Every connection here owns its listeners and
// every operation has a real deadline.

const adb = require('./adb.js');

const SDB_PORT = 26101;
const DEFAULT_CONNECT_TIMEOUT = 8000;
const DEFAULT_EXEC_TIMEOUT = 120000;

// sysinfo: replies with fixed-width 64-byte fields.
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

    // Nothing listens to the socket once `connect` has handed it over: its
    // listeners are removed when the promise settles, deliberately, so they
    // cannot fire twice. That leaves an unhandled 'error' event for anything
    // that goes wrong afterwards — and in Node an unhandled 'error' is not a
    // rejected promise, it is the process exiting with a stack trace.
    //
    // sdbd resets connections in ordinary use: a second client arriving, a
    // television going to sleep mid-upload. Recording it here keeps that a
    // failed command rather than a crash; whatever is in flight then ends on
    // its own deadline, which every operation has.
    const socket = client && client._socket;

    if (socket) {
        socket.on('error', (error) => { this._socketError = error; });
    }
}

// Runs a command and collects its output.
//
// `until` lets a caller finish as soon as the output proves the command
// succeeded. Several Samsung shell commands (notably vd_appinstall) keep the
// stream open after they are done, so waiting for 'end' would always hit the
// timeout.
Session.prototype.exec = function (command, options) {
    const opts = options || {};
    const timeout = opts.timeout || DEFAULT_EXEC_TIMEOUT;
    const until = opts.until;
    // Called with each chunk as it arrives, so a caller can stream output
    // instead of waiting for the command to finish.
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
                // A throwing consumer must not tear down the command.
                try { onChunk(text); } catch (e) { /* ignore */ }
            }
            if (until && until(output)) finish(null, output);
        }

        function onError(e) {
            finish(SdbError('sdbStreamError', `SDB stream error: ${e}`), null);
        }

        // A socket that died before this command was issued would otherwise
        // only show up as a timeout, seconds later, saying nothing useful.
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

// Reads the platform version out of the fixed-width sysinfo: response.
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

// The DUID identifies this specific TV; Samsung binds minted certificates to
// it, so resigning cannot proceed without it.
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

        function onError(e) {
            if (e && e.code === 'ECONNREFUSED') {
                // sdbd is not listening: Developer Mode is off.
                return finish(SdbError('sdbRefused', 'SDB refused the connection. Developer Mode is probably off.'), null);
            }
            if (e && e.code === 'ECONNRESET') {
                // sdbd is listening but rejected us: the developer host IP is
                // set to something other than this TV.
                return finish(SdbError('sdbReset', 'SDB reset the connection. The developer host IP is probably not 127.0.0.1.'), null);
            }
            finish(SdbError('sdbError', `SDB connection error: ${e && e.message ? e.message : e}`), null);
        }

        function onClose() {
            finish(SdbError('sdbClosed', 'SDB closed the connection before the handshake completed. The developer host IP is probably not this machine.'), null);
        }

        // Resolve on the ADB handshake, not the TCP connect. sdbd accepts the
        // socket from any address and only then resets it if the developer
        // host IP does not match, so resolving on the socket's own 'connect'
        // reports success against a TV that is about to reject us — and the
        // real failure then surfaces later, somewhere misleading.
        client.on('connect', onConnect);
        stream.on('error', onError);
        stream.on('close', onClose);
    });
}

// Runs `fn` against a fresh session and always tears it down afterwards.
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
