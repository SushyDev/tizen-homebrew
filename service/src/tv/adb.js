'use strict';

// The ADB wire protocol, enough of it to install a package. Vendored from `adbhost@0.0.2`, which
// is unmaintained and carried four bugs this code was already working around.

const net = require('net');
const { EventEmitter } = require('events');
const { Duplex } = require('stream');

const COMMANDS = ['SYNC', 'OPEN', 'CNXN', 'AUTH', 'OKAY', 'CLSE', 'WRTE']
    .reduce((all, name) => ({ ...all, [name]: Buffer.from(name).readUInt32LE(0) }), {});

const HEADER_BYTES = 24;

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
    // The magic is the command's one's complement, which is how a peer spots a desynchronised stream.
    packet.writeUInt32LE(0xFFFFFFFF - command, 20);

    if (length > 0) data.copy(packet, HEADER_BYTES);

    return packet;
};

const decodeHeader = (header) => ({
    command: header.readUInt32LE(0),
    arg1: header.readUInt32LE(4),
    arg2: header.readUInt32LE(8),
    dataLength: header.readUInt32LE(12),
    data: null
});

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

    _write(chunk, _encoding, done) {
        this._queue.push({ chunk, done });
        this._flush();
    }

    // ADB is lock-step: one WRTE per stream, then the peer's OKAY. Firing five hundred packets at sdbd
    // without pause loses whatever it has no room for, and the install fails on a signature that is fine.
    _flush() {
        if (this._remoteId === -1 || this._inFlight || this._queue.length === 0) return;

        const { chunk, done } = this._queue.shift();

        this._inFlight = done;
        this._connection._send(COMMANDS.WRTE, this._localId, this._remoteId, chunk);
    }

    _acknowledge() {
        const done = this._inFlight;

        this._inFlight = null;

        if (done) done();

        this._flush();
    }

    _read() {}
}

// Emits `connect` on the handshake, not the socket: sdbd accepts from anyone, then drops on a mismatch.
class AdbConnection extends EventEmitter {
    constructor({ host = '127.0.0.1', port = 5555, socket = null } = {}) {
        super();

        this._socket = socket || net.connect(port, host);
        this._streams = new Map();
        this._nextStreamId = 12345;
        this._connected = false;
        this._handshakeDone = false;

        this._header = null;
        this._awaitingHeader = true;

        this._socket.on('readable', () => this._drain());

        this._socket.on('connect', () => {
            this._connected = true;
            // version, max payload, identity. The sync code depends on that 4096.
            this._send(COMMANDS.CNXN, 0x01000000, 4096, 'host::');
        });
    }

    _drain() {
        for (;;) {
            if (this._awaitingHeader) {
                const header = this._socket.read(HEADER_BYTES);
                if (!header) return;

                this._header = decodeHeader(header);

                if (this._header.dataLength === 0) {
                    this._dispatch(this._header);
                } else {
                    this._awaitingHeader = false;
                }
            } else {
                const data = this._socket.read(this._header.dataLength);
                if (!data) return;

                this._dispatch({ ...this._header, data });
                this._awaitingHeader = true;
            }
        }
    }

    _dispatch(packet) {
        const stream = this._streams.get(packet.arg2);

        switch (packet.command) {
            case COMMANDS.CNXN:
                this._banner = packet.data ? packet.data.toString().split(':') : [];
                this._handshakeDone = true;
                this.emit('connect');
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
                // AUTH is unreachable here: sdbd on a TV in developer mode authorises by host IP.
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

module.exports = { createConnection, encodePacket, checksum, COMMANDS, HEADER_BYTES };
