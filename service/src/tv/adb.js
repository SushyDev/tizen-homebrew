'use strict';

// The ADB wire protocol, enough of it to install a package. Vendored from `adbhost@0.0.2`, which
// is unmaintained and carried four bugs this code was already working around. Framing follows
// `check_header`/`check_data` in Tizen's own sdb client (sdk/tools/sdb, src/transport.c).

const net = require('net');
const { EventEmitter } = require('events');
const { Duplex } = require('stream');

const COMMANDS = ['SYNC', 'OPEN', 'CNXN', 'AUTH', 'OKAY', 'CLSE', 'WRTE']
    .reduce((all, name) => ({ ...all, [name]: Buffer.from(name).readUInt32LE(0) }), {});

const NAMES = Object.keys(COMMANDS)
    .reduce((all, name) => ({ ...all, [COMMANDS[name]]: name }), {});

const HEADER_BYTES = 24;

// Both sides of the handshake declare 4096, and sdbd will not read a longer packet.
const MAX_PAYLOAD = 4096;

// A connection is held open between commands, so a peer that vanished has to surface as an error.
const KEEPALIVE_MS = 30000;

const nameOf = (command) => NAMES[command] || `0x${(command >>> 0).toString(16)}`;

// The magic is the command's one's complement, which is how a peer spots a desynchronized stream.
const magicFor = (command) => (command ^ 0xFFFFFFFF) >>> 0;

const checksum = (data) => {
    if (!data) return 0;

    let total = 0;
    for (let index = 0; index < data.length; index++) total = (total + data[index]) & 0xFFFFFFFF;
    return total;
};

const encodePacket = (command, arg1, arg2, payload) => {
    // A string payload is sent NUL-terminated, which is what the daemon expects for service names.
    const data = typeof payload === 'string'
        ? Buffer.concat([Buffer.from(payload), Buffer.from([0])])
        : payload;

    const length = data ? data.length : 0;
    const packet = Buffer.alloc(HEADER_BYTES + length);

    packet.writeUInt32LE(command, 0);
    packet.writeUInt32LE(arg1, 4);
    packet.writeUInt32LE(arg2, 8);
    packet.writeUInt32LE(length, 12);
    packet.writeUInt32LE(checksum(data), 16);
    packet.writeUInt32LE(magicFor(command), 20);

    if (length > 0) data.copy(packet, HEADER_BYTES);

    return packet;
};

const decodeHeader = (header) => ({
    command: header.readUInt32LE(0),
    arg1: header.readUInt32LE(4),
    arg2: header.readUInt32LE(8),
    dataLength: header.readUInt32LE(12),
    dataCheck: header.readUInt32LE(16),
    magic: header.readUInt32LE(20),
    data: null
});

// Says what is wrong with a header rather than whether it is fine, so the failure can name itself.
const headerFault = (header) => {
    if (header.magic !== magicFor(header.command)) {
        return `${nameOf(header.command)} carried magic 0x${header.magic.toString(16)} where ` +
            `0x${magicFor(header.command).toString(16)} was due — the packet stream is out of step`;
    }

    if (header.dataLength > MAX_PAYLOAD) {
        return `${nameOf(header.command)} declared ${header.dataLength} bytes of payload, past the ` +
            `${MAX_PAYLOAD} the handshake agreed — the packet stream is out of step`;
    }

    return null;
};

// Writes made before the daemon answers OPEN are held and flushed on `open`.
class AdbStream extends Duplex {
    constructor(connection, localId) {
        super();

        this._connection = connection;
        this._localId = localId;
        this._remoteId = -1;

        this._queue = [];
        this._inFlight = null;

        this.once('open', () => this._flush());
    }

    localId() { return this._localId; }
    remoteId() { return this._remoteId; }

    // One WRTE may not carry more than the agreed maxdata, so a longer write goes out in pieces.
    _write(chunk, _encoding, done) {
        const limit = this._connection.maxPayload();

        if (chunk.length <= limit) {
            this._queue.push({ chunk, done });
        } else {
            for (let at = 0; at < chunk.length; at += limit) {
                const last = at + limit >= chunk.length;
                this._queue.push({ chunk: chunk.slice(at, at + limit), done: last ? done : null });
            }
        }

        this._flush();
    }

    // ADB is lock-step: one WRTE per stream, then the peer's OKAY. Firing five hundred packets at sdbd
    // without pause loses whatever it has no room for, and the install fails on a signature that is fine.
    _flush() {
        if (this._remoteId === -1 || this._inFlight || this._queue.length === 0) return;

        const { chunk, done } = this._queue.shift();

        this._inFlight = done || (() => {});
        this._connection._send(COMMANDS.WRTE, this._localId, this._remoteId, chunk);
    }

    _acknowledge() {
        const done = this._inFlight;

        this._inFlight = null;

        if (done) done();

        this._flush();
    }

    _read() {}

    // A caller that has stopped reading says so, or sdbd keeps writing to a stream nobody owns.
    close() {
        this._connection._closeStream(this);
    }
}

// Emits `connect` on the handshake, not the socket: sdbd accepts from anyone, then drops on a mismatch.
class AdbConnection extends EventEmitter {
    constructor({ host = '127.0.0.1', port = 5555, socket = null, log = null } = {}) {
        super();

        this._socket = socket || net.connect(port, host);
        this._streams = new Map();
        this._nextStreamId = 12345;
        this._connected = false;
        this._handshakeDone = false;
        this._maxPayload = MAX_PAYLOAD;
        this._log = log || (() => {});

        this._header = null;
        this._awaitingHeader = true;

        if (this._socket.setKeepAlive) this._socket.setKeepAlive(true, KEEPALIVE_MS);

        this._socket.on('readable', () => this._drain());

        // Also keeps a late socket error from reaching Node as an unhandled event, which exits the process.
        this._socket.on('error', (error) => this._abandon(error));
        this._socket.on('close', () => this._abandon(Object.assign(
            new Error('sdbd closed the connection with a command still running'),
            { code: 'ESDBCLOSED' })));

        this._socket.on('connect', () => {
            this._connected = true;
            // version, max payload, identity. The sync code depends on that 4096.
            this._send(COMMANDS.CNXN, 0x01000000, MAX_PAYLOAD, 'host::');
        });
    }

    maxPayload() { return this._maxPayload; }

    _drain() {
        for (;;) {
            if (this._awaitingHeader) {
                const header = this._socket.read(HEADER_BYTES);
                if (!header) return;

                this._header = decodeHeader(header);

                const fault = headerFault(this._header);
                if (fault) return this._desynchronized(fault);

                if (this._header.dataLength === 0) {
                    this._dispatch(this._header);
                } else {
                    this._awaitingHeader = false;
                }
            } else {
                const data = this._socket.read(this._header.dataLength);
                if (!data) return;

                if (checksum(data) !== this._header.dataCheck) {
                    return this._desynchronized(
                        `${nameOf(this._header.command)} payload sums to ${checksum(data)} where ` +
                        `${this._header.dataCheck} was due — the packet stream is out of step`);
                }

                this._dispatch({ ...this._header, data });
                this._awaitingHeader = true;
            }
        }
    }

    // Nothing resynchronizes an ADB stream, so a mis-framed packet ends the connection, as it does for sdbd.
    _desynchronized(fault) {
        this._fatal('ESDBFRAMING', fault);
    }

    _fatal(code, message) {
        this._socket.destroy(Object.assign(new Error(message), { code }));
    }

    // sdbd hears the streams go before the socket does, and the socket goes with a FIN: destroying one
    // that still has unread bytes sends a reset instead, and sdbd resets the next client after one of those.
    close() {
        if (this._handshakeDone) {
            this._streams.forEach((stream) => this._send(
                COMMANDS.CLSE, stream.localId(), stream.remoteId() === -1 ? 0 : stream.remoteId()));
        }

        // Whatever is still arriving has to be read, or the close is abortive anyway.
        this._socket.removeAllListeners('readable');
        this._socket.on('data', () => {});
        this._socket.end();
    }

    _closeStream(stream) {
        // Gone from the map means sdbd closed it first, and there is nothing left to tell it.
        if (!this._streams.has(stream.localId())) return;

        this._streams.delete(stream.localId());

        if (this._handshakeDone) {
            this._send(COMMANDS.CLSE, stream.localId(), stream.remoteId() === -1 ? 0 : stream.remoteId());
        }

        stream.push(null);
        stream.end();
    }

    // A dead socket leaves every open command waiting on output that will never come.
    _abandon(error) {
        const streams = Array.from(this._streams.values());

        this._streams.clear();

        streams.forEach((stream) => {
            if (error && stream.listenerCount('error') > 0) stream.emit('error', error);
            stream.push(null);
            stream.end();
        });
    }

    _dispatch(packet) {
        const stream = this._streams.get(packet.arg2);

        switch (packet.command) {
            case COMMANDS.CNXN:
                this._banner = packet.data ? packet.data.toString().split(':') : [];
                // sdbd offers 4096; a daemon that offers less is taken at its word.
                this._maxPayload = Math.min(MAX_PAYLOAD, packet.arg2 || MAX_PAYLOAD);
                this._handshakeDone = true;
                this.emit('connect');
                break;

            case COMMANDS.AUTH:
                // sdbd on a TV in developer mode authorizes by host IP, so a key challenge is a
                // daemon this client cannot satisfy rather than a step it forgot to take.
                this._fatal('ESDBAUTH',
                    `sdbd asked for key authentication (AUTH type ${packet.arg1}), which this client ` +
                    'cannot answer — it authorizes by developer host IP, not by signed key.');
                break;

            case COMMANDS.OKAY:
                if (!stream) break;

                // The first OKAY carries the remote id; every later one says there is room.
                if (stream._remoteId === -1) {
                    stream._remoteId = packet.arg1;
                    stream.emit('open');
                } else {
                    stream._acknowledge();
                }
                break;

            case COMMANDS.WRTE:
                if (!stream) break;
                stream.push(packet.data);
                this._send(COMMANDS.OKAY, stream.localId(), stream.remoteId());
                break;

            case COMMANDS.CLSE:
                if (!stream) break;
                stream.push(null);
                stream.end();
                this._streams.delete(packet.arg2);
                break;

            default:
                this._log(`sdbd sent ${nameOf(packet.command)} (${packet.dataLength} bytes), ` +
                    'which this client has no use for');
                break;
        }
    }

    _send(command, arg1, arg2, payload) {
        if (!this._connected) {
            this._socket.once('connect', () => this._send(command, arg1, arg2, payload));
            return;
        }

        this._socket.write(encodePacket(command, arg1, arg2, payload));
    }

    createStream(service) {
        const stream = new AdbStream(this, this._nextStreamId++);
        this._streams.set(stream.localId(), stream);

        const open = () => this._send(COMMANDS.OPEN, stream.localId(), 0, service);

        if (this._handshakeDone) open();
        else this.once('connect', open);

        return stream;
    }
}

const createConnection = (options) => new AdbConnection(options);

module.exports = {
    createConnection, encodePacket, decodeHeader, headerFault, checksum,
    COMMANDS, HEADER_BYTES, MAX_PAYLOAD
};
