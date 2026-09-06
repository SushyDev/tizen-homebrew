'use strict';

// A stand-in sdbd on a loopback port, so the client's framing, its retries and the connection it
// keeps can be exercised without a television.

const net = require('net');

const adb = require('../src/tv/adb.js');
const sdb = require('../src/tv/sdb.js');

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

const listen = (onConnection) => new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, '127.0.0.1', () => resolve(server));
});

const shut = (server) => new Promise((resolve) => server.close(resolve));

const packets = (socket, onPacket) => {
    let held = Buffer.alloc(0);

    socket.on('error', () => {});
    socket.on('data', (chunk) => {
        held = Buffer.concat([held, chunk]);

        for (;;) {
            if (held.length < adb.HEADER_BYTES) return;

            const header = adb.decodeHeader(held.slice(0, adb.HEADER_BYTES));
            const total = adb.HEADER_BYTES + header.dataLength;

            if (held.length < total) return;

            header.data = held.slice(adb.HEADER_BYTES, total);
            held = held.slice(total);

            onPacket(header);
        }
    });
};

const corrupt = (packet, offset, value) => {
    const copy = Buffer.from(packet);
    copy.writeUInt32LE(value, offset);
    return copy;
};

// The stream id this daemon gives out; every scenario here runs one stream at a time per command.
const REMOTE = 42;

const banner = () => adb.encodePacket(adb.COMMANDS.CNXN, 0x01000000, adb.MAX_PAYLOAD, 'device::tv');

const okay = (socket, header) => socket.write(adb.encodePacket(adb.COMMANDS.OKAY, REMOTE, header.arg1));
const wrote = (socket, header, text) =>
    socket.write(adb.encodePacket(adb.COMMANDS.WRTE, REMOTE, header.arg1, Buffer.from(text)));
const bye = (socket, header) => socket.write(adb.encodePacket(adb.COMMANDS.CLSE, REMOTE, header.arg1));

// Answers the handshake; every packet after it is the scenario's business.
const daemon = (onPacket) => (socket) => {
    packets(socket, (header) => {
        if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());
        if (onPacket) onPacket(header, socket);
    });
};

// Answers one command with `reply`, and closes the stream once the client acknowledges it.
const wellBehaved = (reply) => daemon((header, socket) => {
    if (header.command === adb.COMMANDS.OPEN) {
        okay(socket, header);
        wrote(socket, header, reply);
    } else if (header.command === adb.COMMANDS.OKAY) {
        bye(socket, header);
    }
});

// Each OPEN gets its own answer, so a retried read is answered afresh.
const answering = (chunks) => daemon((header, socket) => {
    if (header.command !== adb.COMMANDS.OPEN) return;

    okay(socket, header);
    chunks.forEach((text, at) => setTimeout(() => wrote(socket, header, text), at * 20));
});

const against = async (behaviour, run) => {
    const server = await listen(behaviour);

    try {
        return await run(server.address().port);
    } finally {
        await shut(server);
    }
};

const dial = (port, extra) => sdb.connect(Object.assign({ port, timeout: 2000 }, extra));

const failure = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    await against(wellBehaved('hello\n'), async (port) => {
        const session = await dial(port);
        const output = await session.exec('shell:0 echo hello', { timeout: 2000 });

        session.close();

        check('a command runs against a well-behaved daemon', output === 'hello\n', JSON.stringify(output));
    });

    await against((socket) => {
        packets(socket, () => socket.write(corrupt(banner(), 20, 0)));
    }, async (port) => {
        const { error } = await failure(dial(port, { attempts: 1 }));

        check('a wrong magic is refused rather than dispatched',
            !!error && error.code === 'sdbFraming' && /magic/.test(error.message),
            error ? `${error.code}: ${error.message}` : 'it connected');
    });

    await against((socket) => {
        packets(socket, () => socket.write(corrupt(adb.encodePacket(adb.COMMANDS.WRTE, 1, 2), 12, 99999)));
    }, async (port) => {
        const { error } = await failure(dial(port, { attempts: 1 }));

        check('a payload longer than the agreed maximum is refused',
            !!error && error.code === 'sdbFraming' && /99999/.test(error.message),
            error ? `${error.code}: ${error.message}` : 'it connected');
    });

    await against(daemon((header, socket) => {
        if (header.command !== adb.COMMANDS.OPEN) return;

        okay(socket, header);
        socket.write(corrupt(
            adb.encodePacket(adb.COMMANDS.WRTE, REMOTE, header.arg1, Buffer.from('hello\n')), 16, 1));
    }), async (port) => {
        const session = await dial(port);
        const { error } = await failure(session.exec('shell:0 echo hello', { timeout: 2000 }));

        session.close();

        check('a payload that does not sum to its checksum is refused',
            !!error && /sums to/.test(error.message), error ? error.message : 'it succeeded');
    });

    await against((socket) => {
        packets(socket, () => socket.write(
            adb.encodePacket(adb.COMMANDS.AUTH, 1, 0, Buffer.from('token'))));
    }, async (port) => {
        const { error } = await failure(dial(port, { attempts: 1 }));

        check('an AUTH challenge fails by name instead of silently',
            !!error && error.code === 'sdbAuthRequired' && /AUTH/.test(error.message),
            error ? `${error.code}: ${error.message}` : 'it connected');
    });

    let connections = 0;
    await against((socket) => {
        connections++;
        if (connections === 1) return socket.destroy();
        wellBehaved('hello\n')(socket);
    }, async (port) => {
        const said = [];
        const session = await dial(port, { backoff: 20, log: (line) => said.push(line) });

        session.close();

        check('a connection dropped mid-handshake is retried on a fresh socket',
            connections === 2 && said.some((line) => /retrying/.test(line)),
            `${connections} connections, log ${JSON.stringify(said)}`);
    });

    const vacant = await listen(() => {});
    const deadPort = vacant.address().port;
    await shut(vacant);

    const refusedAt = Date.now();
    const refused = await failure(dial(deadPort, { backoff: 1000 }));
    const refusedIn = Date.now() - refusedAt;

    check('a refusal is not retried, so Developer Mode being off answers at once',
        !!refused.error && refused.error.code === 'sdbRefused' && refusedIn < 500,
        refused.error ? `${refused.error.code} after ${refusedIn}ms` : 'it connected');

    await against(daemon((header, socket) => {
        if (header.command === adb.COMMANDS.OPEN) {
            // Well-framed, and nothing this client has a case for.
            socket.write(adb.encodePacket(adb.COMMANDS.SYNC, 0, 0));
            okay(socket, header);
            wrote(socket, header, 'hello\n');
        } else if (header.command === adb.COMMANDS.OKAY) {
            bye(socket, header);
        }
    }), async (port) => {
        const said = [];
        const session = await dial(port, { log: (line) => said.push(line) });
        const output = await session.exec('shell:0 echo hello', { timeout: 2000 });

        session.close();

        check('a packet the client has no use for is reported, not swallowed',
            output === 'hello\n' && said.some((line) => /SYNC/.test(line)),
            `output ${JSON.stringify(output)}, log ${JSON.stringify(said)}`);
    });

    await against(daemon((header, socket) => {
        if (header.command !== adb.COMMANDS.OPEN) return;

        okay(socket, header);
        setTimeout(() => socket.destroy(), 50);
    }), async (port) => {
        const session = await dial(port);

        const began = Date.now();
        const { error } = await failure(session.exec('shell:0 sleep 100', { timeout: 5000 }));
        const spent = Date.now() - began;

        session.close();

        check('a command whose connection dies fails then, not at its timeout',
            !!error && spent < 1000 && /closed the connection/.test(error.message),
            error ? `${error.message} after ${spent}ms` : 'it resolved');
    });

    await against(answering(['2DCKJ', 'ITTLDPSA\n']), async (port) => {
        const session = await dial(port);
        const duid = await session.getDuid();

        session.close();

        check('a device id split across packets comes back whole', duid === '2DCKJITTLDPSA', duid);
    });

    await against(answering(['sh: getduid: command not found\n']), async (port) => {
        const session = await dial(port);
        const { error, value } = await failure(session.getDuid({ attempts: 2 }));

        session.close();

        check('a reply that is not a device id is refused rather than minted against',
            !!error && error.code === 'sdbDuid', error ? error.message : `it answered ${value}`);
    });

    // The shared connection is module state, so each of these starts and leaves it released.
    sdb.release();

    let sockets = 0;
    const counted = (behaviour) => (socket) => {
        sockets++;
        behaviour(socket);
    };

    await against(counted(wellBehaved('hi\n')), async (port) => {
        const first = await sdb.withSession({ port, timeout: 2000 },
            (session) => session.exec('shell:0 one', { timeout: 2000 }));
        const second = await sdb.withSession({ port, timeout: 2000 },
            (session) => session.exec('shell:0 two', { timeout: 2000 }));

        check('a second command reuses the first one\'s connection',
            sockets === 1 && first === 'hi\n' && second === 'hi\n',
            `${sockets} connections, ${JSON.stringify([first, second])}`);

        sdb.release();
    });

    sockets = 0;
    await against(counted(wellBehaved('hi\n')), async (port) => {
        const both = await Promise.all([
            sdb.withSession({ port, timeout: 2000 }, (session) => session.exec('shell:0 one', { timeout: 2000 })),
            sdb.withSession({ port, timeout: 2000 }, (session) => session.exec('shell:0 two', { timeout: 2000 }))
        ]);

        check('two commands at once multiplex over that one connection',
            sockets === 1 && both.join('') === 'hi\nhi\n', `${sockets} connections, ${JSON.stringify(both)}`);

        sdb.release();
    });

    let ended = false;
    let closes = 0;
    await against((socket) => {
        socket.on('end', () => { ended = true; });

        daemon((header) => {
            if (header.command === adb.COMMANDS.OPEN) okay(socket, header);
            if (header.command === adb.COMMANDS.CLSE) closes++;
        })(socket);
    }, async (port) => {
        const running = sdb.withSession({ port, timeout: 2000 },
            (session) => session.exec('shell:0 sleep 100', { timeout: 3000 }));

        await wait(150);

        const began = Date.now();
        sdb.release();
        await failure(running);
        const spent = Date.now() - began;

        await wait(150);

        check('a released connection closes its streams and ends the socket, rather than resetting it',
            closes === 1 && ended, `${closes} CLSE, socket ended ${ended}`);

        check('and the command it was carrying settles then, not at its own timeout',
            spent < 1000, `it took ${spent}ms`);
    });

    let attempts = 0;
    await against((socket) => {
        attempts++;

        if (attempts > 1) return wellBehaved('hi\n')(socket);

        daemon((header) => {
            if (header.command !== adb.COMMANDS.OPEN) return;

            okay(socket, header);
            setTimeout(() => socket.destroy(), 30);
        })(socket);
    }, async (port) => {
        const broke = await failure(sdb.withSession({ port, timeout: 2000 },
            (session) => session.exec('shell:0 one', { timeout: 3000 })));

        const after = await sdb.withSession({ port, timeout: 2000 },
            (session) => session.exec('shell:0 two', { timeout: 2000 }));

        check('a connection that broke is dropped, and the next command reconnects',
            !!broke.error && attempts === 2 && after === 'hi\n',
            `${attempts} connections, ${broke.error ? broke.error.code : 'no error'}, ${JSON.stringify(after)}`);

        sdb.release();
    });

    let told = 0;
    let chatter = null;
    await against(daemon((header, socket) => {
        if (header.command === adb.COMMANDS.OPEN) {
            okay(socket, header);
            wrote(socket, header, 'done\n');

            // As vd_appinstall does, the daemon keeps talking after the line that says it worked.
            chatter = setInterval(() => wrote(socket, header, 'still here\n'), 20);
            return;
        }

        if (header.command === adb.COMMANDS.CLSE) {
            told++;
            clearInterval(chatter);
        }
    }), async (port) => {
        const output = await sdb.withSession({ port, timeout: 2000 }, (session) =>
            session.exec('shell:0 vd_appinstall', { timeout: 2000, until: (o) => /done/.test(o) }));

        await wait(100);

        check('a command that stops on its own gives the stream back instead of leaving it running',
            told === 1 && output === 'done\n', `${told} CLSE, ${JSON.stringify(output)}`);

        sdb.release();
        clearInterval(chatter);
    });

    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error('Harness error:', err);
    process.exit(1);
});
