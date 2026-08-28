'use strict';

// The ADB wire protocol, enough of it to install a package.
//
// Vendored from `adbhost@0.0.2`, which is unmaintained and carried four bugs
// that this code had already been working around or was about to be bitten by:
//
//   1. `packet = this._packet` assigned an *implicit global*. Fine in sloppy
//      mode, which is what ncc emitted; a ReferenceError in strict mode, which
//      is what a modern bundler emits. This crashed every install the moment
//      the build changed, on a line nobody had touched.
//   2. `_CNXN` was emitted on the *client* while its own stream listened for
//      it on the *stream*, so the library's "queue a write until the stream
//      opens" path could never fire.
//   3. `streamFromOpts` returned an undeclared local instead of `opts.stream`,
//      so passing a ready-made socket silently produced null.
//   4. `new Buffer()` throughout, deprecated for a decade.
//
// Keeping a dependency whose bugs must all be worked around is more expensive
// than owning two hundred lines. The wire behaviour here is unchanged — it is
// what the TV already speaks.

const net = require('net');
const { EventEmitter } = require('events');
const { Duplex } = require('stream');

// ── Packets ───────────────────────────────────────────────────────────

// Every ADB command is a four-character tag read as a little-endian uint32.
const COMMANDS = ['SYNC', 'OPEN', 'CNXN', 'AUTH', 'OKAY', 'CLSE', 'WRTE']
    .reduce((all, name) => ({ ...all, [name]: Buffer.from(name).readUInt32LE(0) }), {});

const HEADER_BYTES = 24;

// Not CRC32 — ADB sums the bytes. Named for what it is, since the original's
// comment apologising for the name was the only hint.
const checksum = (data) => {
    if (!data) return 0;

    let total = 0;
    for (let index = 0; index < data.length; index++) total = (total + data[index]) & 0xFFFFFFFF;
    return total;
};

/** Serialises one packet: a 24-byte header followed by its payload. */
const encodePacket = (command, arg1, arg2, payload) => {
    // A string payload is sent NUL-terminated; that is what the daemon expects
    // for service names like `shell:0 getduid`.
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
    // The magic is the command's one's complement, which is how a peer spots
    // a desynchronised stream.
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

// ── Streams ───────────────────────────────────────────────────────────

/**
 * One logical stream inside the connection.
 *
 * A Duplex, so a caller can `.write()` to a shell command and read what comes
 * back. Until the daemon answers OPEN with OKAY there is no remote id to
 * address, so writes made before then are held and flushed on `open`.
 */
class AdbStream extends Duplex {
    constructor(connection, localId) {
        super();

        this._connection = connection;
        this._localId = localId;
        this._remoteId = -1;

        // Writes waiting for their turn, and the callback of the one packet
        // currently in flight. See `_flush`.
        this._queue = [];
        this._inFlight = null;

        // Bug 2: the original emitted this on the client but listened on the
        // stream, so queued writes were never flushed. Listening where it is
        // actually emitted is the whole fix.
        this.once('open', () => this._flush());
    }

    localId() { return this._localId; }
    remoteId() { return this._remoteId; }

    _write(chunk, _encoding, done) {
        this._queue.push({ chunk, done });
        this._flush();
    }

    /**
     * Sends the next packet, if the last one has been acknowledged.
     *
     * Bug 5, and the expensive one: ADB is a lock-step protocol. A sender may
     * have exactly one WRTE outstanding per stream and must wait for the
     * peer's OKAY before sending the next — this file already honours that in
     * the other direction, answering every WRTE it receives with an OKAY
     * "because the daemon waits for this before sending more".
     *
     * Going the other way it did not, and dismissed the incoming OKAYs as
     * "flow control we do not need to act on". For a shell command, a handful
     * of packets, nothing goes wrong. For a 2MB package — five hundred packets
     * fired without pause — sdbd drops what it has no room for, and the file
     * that lands is not the file that was sent. The install then fails with a
     * signature error, because the signature is fine and the package is not.
     */
    _flush() {
        if (this._remoteId === -1 || this._inFlight || this._queue.length === 0) return;

        const { chunk, done } = this._queue.shift();

        this._inFlight = done;
        this._connection._send(COMMANDS.WRTE, this._localId, this._remoteId, chunk);
    }

    /** The peer has taken the packet in flight; release the writer and send on. */
    _acknowledge() {
        const done = this._inFlight;

        this._inFlight = null;

        if (done) done();

        this._flush();
    }

    // Reading is driven by packets arriving, not by demand.
    _read() {}
}

// ── The connection ────────────────────────────────────────────────────

/**
 * A connection to an ADB daemon.
 *
 * Emits `connect` once the daemon has answered the handshake — which is not
 * the same as the socket connecting, and the difference matters: sdbd accepts
 * the TCP connection from anyone and only then drops it if the developer host
 * IP does not match.
 */
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
            // version, max payload, identity. 4096 is what the daemon is told
            // to send at most, and the sync code depends on that number.
            this._send(COMMANDS.CNXN, 0x01000000, 4096, 'host::');
        });
    }

    /** Reads whole packets out of the socket, header first, then payload. */
    _drain() {
        for (;;) {
            if (this._awaitingHeader) {
                const header = this._socket.read(HEADER_BYTES);
                if (!header) return;

                this._header = decodeHeader(header);

                // A payloadless packet is complete as soon as its header is.
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

                // The first OKAY answers our OPEN and carries the remote id.
                // Every later one is the daemon saying it has room for the
                // next packet, which is the only thing that makes a large
                // write arrive intact.
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
                // The daemon waits for this before sending more.
                this._send(COMMANDS.OKAY, stream.localId(), stream.remoteId());
                break;

            case COMMANDS.CLSE:
                if (!stream) break;
                stream.push(null);
                stream.end();
                this._streams.delete(packet.arg2);
                break;

            default:
                // AUTH is unreachable here: sdbd on a TV in developer mode
                // authorises by host IP, not by key.
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

    /**
     * Opens a stream for a service — `shell:0 getduid`, `sync:`, and so on.
     *
     * Safe to call before the handshake completes; the OPEN is held until the
     * daemon has answered.
     */
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
