'use strict';

// The ADB framing against a fake sdbd, because no test covered the transport and the television
// cannot be asked to hold still. The server splits and coalesces packets on purpose: `_drain` reads
// exact byte counts off `readable`, so a runtime that short-reads desynchronizes here and nowhere
// visible.

const net = require('net');

const adb = require('../src/tv/adb.js');
const sdb = require('../src/tv/sdb.js');

const { COMMANDS, HEADER_BYTES, encodePacket, checksum } = adb;

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const DUID = 'CPCLIM2YRW7DO';
const CHUNKED = 'one two three four five END';
const REMOTE_ID = 7;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parser = (onPacket) => {
    let buffer = Buffer.alloc(0);

    return (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        for (;;) {
            if (buffer.length < HEADER_BYTES) return;

            const dataLength = buffer.readUInt32LE(12);
            if (buffer.length < HEADER_BYTES + dataLength) return;

            onPacket({
                command: buffer.readUInt32LE(0),
                arg1: buffer.readUInt32LE(4),
                arg2: buffer.readUInt32LE(8),
                data: buffer.slice(HEADER_BYTES, HEADER_BYTES + dataLength)
            });

            buffer = buffer.slice(HEADER_BYTES + dataLength);
        }
    };
};

const written = [];
let overlapped = false;
let outstanding = 0;

const serve = (socket) => {
    const feed = parser((packet) => {
        if (packet.command === COMMANDS.CNXN) {
            // Split so the client's read(24) has to come back empty once and resume.
            const reply = encodePacket(COMMANDS.CNXN, 0x01000000, 4096, 'device::sdbd');
            socket.write(reply.slice(0, 10));
            setTimeout(() => socket.write(reply.slice(10)), 15);
            return;
        }

        if (packet.command === COMMANDS.OPEN) {
            const service = packet.data.toString().replace(/\0$/, '');
            const okay = encodePacket(COMMANDS.OKAY, REMOTE_ID, packet.arg1);

            if (service === 'shell:0 getduid') {
                // Two packets in one write, so the client has to find the second in the same chunk.
                const out = encodePacket(COMMANDS.WRTE, REMOTE_ID, packet.arg1, Buffer.from(`${DUID}\n`));
                socket.write(Buffer.concat([okay, out]));
                return;
            }

            if (service === 'shell:0 chunked') {
                const out = encodePacket(COMMANDS.WRTE, REMOTE_ID, packet.arg1, Buffer.from(CHUNKED));
                socket.write(okay);
                // Header, then payload, then the rest of the payload.
                setTimeout(() => socket.write(out.slice(0, HEADER_BYTES)), 10);
                setTimeout(() => socket.write(out.slice(HEADER_BYTES, HEADER_BYTES + 8)), 20);
                setTimeout(() => socket.write(out.slice(HEADER_BYTES + 8)), 30);
                return;
            }

            socket.write(okay);
            return;
        }

        if (packet.command === COMMANDS.WRTE) {
            if (outstanding > 0) overlapped = true;

            outstanding += 1;
            written.push(Buffer.from(packet.data));

            // Acknowledge late: a client that does not wait for OKAY shows up as an overlap.
            setTimeout(() => {
                outstanding -= 1;
                socket.write(encodePacket(COMMANDS.OKAY, REMOTE_ID, packet.arg1));
            }, 10);
        }
    });

    socket.on('data', feed);
    socket.on('error', () => { /* the client hangs up when the session closes */ });
};

const main = async () => {
    const server = net.createServer(serve);

    const listening = await new Promise((resolve) => {
        server.once('error', (error) => resolve(error));
        server.listen(sdb.SDB_PORT, '127.0.0.1', () => resolve(null));
    });

    if (listening) {
        console.log(`SKIP  adb transport  <- 127.0.0.1:${sdb.SDB_PORT} is busy (${listening.code})`);
        return true;
    }

    const round = encodePacket(COMMANDS.WRTE, 1, 2, Buffer.from('payload'));
    check('encodePacket writes the header the decoder expects',
        round.readUInt32LE(0) === COMMANDS.WRTE && round.readUInt32LE(12) === 7 &&
        round.readUInt32LE(16) === checksum(Buffer.from('payload')) &&
        round.readUInt32LE(20) === 0xFFFFFFFF - COMMANDS.WRTE,
        round.slice(0, HEADER_BYTES).toString('hex'));

    const session = await sdb.connect({ host: '127.0.0.1', timeout: 5000 })
        .catch((error) => error);

    check('the handshake completes across a split CNXN', !(session instanceof Error),
        session instanceof Error ? session.message : '');

    if (session instanceof Error) {
        server.close();
        return false;
    }

    const duid = await session.getDuid().catch((error) => error);
    check('a coalesced OKAY and WRTE reads back whole', duid === DUID, JSON.stringify(duid));

    const chunked = await session
        .exec('shell:0 chunked', { timeout: 5000, until: (out) => out.indexOf('END') !== -1 })
        .catch((error) => error);

    check('a WRTE split across three segments reads back whole', chunked === CHUNKED, JSON.stringify(chunked));

    const stream = session._client.createStream('sync:');
    const sent = ['first', 'second', 'third', 'fourth', 'fifth'];

    // Every callback firing means each OKAY was matched to its WRTE: a stream that drops one hangs here.
    const acknowledged = await Promise.race([
        new Promise((resolve) => {
            let left = sent.length;
            sent.forEach((text) => stream.write(Buffer.from(text), () => {
                left -= 1;
                if (!left) resolve(true);
            }));
        }),
        wait(3000).then(() => false)
    ]);

    check('every write is acknowledged', acknowledged, `${written.length} of ${sent.length} arrived, none completed`);

    check('writes arrive in order', written.map((chunk) => chunk.toString()).join(',') === sent.join(','),
        written.map((chunk) => chunk.toString()).join(','));

    // Guaranteed by Writable today, so this holds a refactor that writes to the socket directly.
    check('one WRTE is on the wire at a time', !overlapped, 'a second WRTE went out before its OKAY');

    session.close();
    server.close();

    return results.every(Boolean);
};

main().then((ok) => {
    const failed = results.filter((result) => !result).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(ok ? 0 : 1);
}, (error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
