'use strict';

// A stand-in sdbd on a loopback port, so the client's framing and its retries can be exercised
// without a television.

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

            const data = held.slice(adb.HEADER_BYTES, total);
            held = held.slice(total);

            onPacket(header, data);
        }
    });
};

const corrupt = (packet, offset, value) => {
    const copy = Buffer.from(packet);
    copy.writeUInt32LE(value, offset);
    return copy;
};

const banner = () => adb.encodePacket(adb.COMMANDS.CNXN, 0x01000000, adb.MAX_PAYLOAD, 'device::tv');

// Answers the handshake, then one command with `reply` and a CLSE once the client acknowledges it.
const wellBehaved = (reply, before) => (socket) => {
    packets(socket, (header) => {
        if (header.command === adb.COMMANDS.CNXN) {
            if (before) socket.write(before);
            socket.write(banner());
            return;
        }

        if (header.command === adb.COMMANDS.OPEN) {
            socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));
            socket.write(adb.encodePacket(adb.COMMANDS.WRTE, 42, header.arg1, Buffer.from(reply)));
            return;
        }

        if (header.command === adb.COMMANDS.OKAY) {
            socket.write(adb.encodePacket(adb.COMMANDS.CLSE, 42, header.arg1));
        }
    });
};

const against = async (behaviour, run) => {
    const server = await listen(behaviour);

    try {
        return await run(server.address().port);
    } finally {
        await shut(server);
    }
};

const failure = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    await against(wellBehaved('hello\n'), async (port) => {
        const session = await sdb.connect({ port, timeout: 2000 });
        const output = await session.exec('shell:0 echo hello', { timeout: 2000 });

        session.close();

        check('a command runs against a well-behaved daemon', output === 'hello\n', JSON.stringify(output));
    });

    await against((socket) => {
        packets(socket, () => socket.write(corrupt(banner(), 20, 0)));
    }, async (port) => {
        const { error } = await failure(sdb.connect({ port, timeout: 2000, attempts: 1 }));

        check('a wrong magic is refused rather than dispatched',
            !!error && error.code === 'sdbFraming' && /magic/.test(error.message),
            error ? `${error.code}: ${error.message}` : 'it connected');
    });

    await against((socket) => {
        packets(socket, () => socket.write(corrupt(adb.encodePacket(adb.COMMANDS.WRTE, 1, 2), 12, 99999)));
    }, async (port) => {
        const { error } = await failure(sdb.connect({ port, timeout: 2000, attempts: 1 }));

        check('a payload longer than the agreed maximum is refused',
            !!error && error.code === 'sdbFraming' && /99999/.test(error.message),
            error ? `${error.code}: ${error.message}` : 'it connected');
    });

    await against((socket) => {
        packets(socket, (header) => {
            if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());

            if (header.command === adb.COMMANDS.OPEN) {
                socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));
                socket.write(corrupt(
                    adb.encodePacket(adb.COMMANDS.WRTE, 42, header.arg1, Buffer.from('hello\n')), 16, 1));
            }
        });
    }, async (port) => {
        const session = await sdb.connect({ port, timeout: 2000 });
        const { error } = await failure(session.exec('shell:0 echo hello', { timeout: 2000 }));

        session.close();

        check('a payload that does not sum to its checksum is refused',
            !!error && /sums to/.test(error.message), error ? error.message : 'it succeeded');
    });

    await against((socket) => {
        packets(socket, () => socket.write(
            adb.encodePacket(adb.COMMANDS.AUTH, 1, 0, Buffer.from('token'))));
    }, async (port) => {
        const { error } = await failure(sdb.connect({ port, timeout: 2000, attempts: 1 }));

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
        const session = await sdb.connect({ port, timeout: 2000, backoff: 20, log: (line) => said.push(line) });

        session.close();

        check('a connection dropped mid-handshake is retried on a fresh socket',
            connections === 2 && said.some((line) => /retrying/.test(line)),
            `${connections} connections, log ${JSON.stringify(said)}`);
    });

    const closed = await listen(() => {});
    const deadPort = closed.address().port;
    await shut(closed);

    const began = Date.now();
    const refused = await failure(sdb.connect({ port: deadPort, timeout: 2000, backoff: 1000 }));
    const spent = Date.now() - began;

    check('a refusal is not retried, so Developer Mode being off answers at once',
        !!refused.error && refused.error.code === 'sdbRefused' && spent < 500,
        refused.error ? `${refused.error.code} after ${spent}ms` : 'it connected');

    await against(wellBehaved('hello\n', adb.encodePacket(adb.COMMANDS.SYNC, 0, 0)), async (port) => {
        const said = [];
        const session = await sdb.connect({ port, timeout: 2000, log: (line) => said.push(line) });
        const output = await session.exec('shell:0 echo hello', { timeout: 2000 });

        session.close();

        check('a packet the client has no use for is reported, not swallowed',
            output === 'hello\n' && said.some((line) => /SYNC/.test(line)),
            `output ${JSON.stringify(output)}, log ${JSON.stringify(said)}`);
    });

    await against((socket) => {
        packets(socket, (header) => {
            if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());

            if (header.command === adb.COMMANDS.OPEN) {
                socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));
                setTimeout(() => socket.destroy(), 50);
            }
        });
    }, async (port) => {
        const session = await sdb.connect({ port, timeout: 2000 });

        const began = Date.now();
        const { error } = await failure(session.exec('shell:0 sleep 100', { timeout: 5000 }));
        const spent = Date.now() - began;

        session.close();

        check('a command whose connection dies fails then, not at its timeout',
            !!error && spent < 1000 && /closed the connection/.test(error.message),
            error ? `${error.message} after ${spent}ms` : 'it resolved');
    });

    // Each OPEN gets its own answer, so a retried read is answered afresh.
    const answering = (chunks) => (socket) => {
        packets(socket, (header) => {
            if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());

            if (header.command === adb.COMMANDS.OPEN) {
                socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));

                chunks.forEach((text, at) => setTimeout(() => socket.write(
                    adb.encodePacket(adb.COMMANDS.WRTE, 42, header.arg1, Buffer.from(text))), at * 20));
            }
        });
    };

    await against(answering(['2DCKJ', 'ITTLDPSA\n']), async (port) => {
        const session = await sdb.connect({ port, timeout: 2000 });
        const duid = await session.getDuid();

        session.close();

        check('a device id split across packets comes back whole', duid === '2DCKJITTLDPSA', duid);
    });

    await against(answering(['sh: getduid: command not found\n']), async (port) => {
        const session = await sdb.connect({ port, timeout: 2000 });
        const { error, value } = await failure(session.getDuid({ attempts: 2 }));

        session.close();

        check('a reply that is not a device id is refused rather than minted against',
            !!error && error.code === 'sdbDuid', error ? error.message : `it answered ${value}`);
    });

    // The shared connection is module state, so each of these starts and leaves it released.
    sdb.release();

    let sockets = 0;
    await against((socket) => {
        sockets++;
        wellBehaved('hi\n')(socket);
    }, async (port) => {
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
    await against((socket) => {
        sockets++;
        wellBehaved('hi\n')(socket);
    }, async (port) => {
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

        packets(socket, (header) => {
            if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());
            if (header.command === adb.COMMANDS.OPEN) {
                return socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));
            }
            if (header.command === adb.COMMANDS.CLSE) closes++;
        });
    }, async (port) => {
        const running = sdb.withSession({ port, timeout: 2000 },
            (session) => session.exec('shell:0 sleep 100', { timeout: 3000 }));

        await wait(150);
        sdb.release();
        await failure(running);
        await wait(150);

        check('a released connection closes its streams and ends the socket, rather than resetting it',
            closes === 1 && ended, `${closes} CLSE, socket ended ${ended}`);
    });

    let attempts = 0;
    await against((socket) => {
        attempts++;

        if (attempts > 1) return wellBehaved('hi\n')(socket);

        packets(socket, (header) => {
            if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());
            if (header.command === adb.COMMANDS.OPEN) {
                socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));
                setTimeout(() => socket.destroy(), 30);
            }
        });
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
    await against((socket) => {
        packets(socket, (header) => {
            if (header.command === adb.COMMANDS.CNXN) return socket.write(banner());

            if (header.command === adb.COMMANDS.OPEN) {
                socket.write(adb.encodePacket(adb.COMMANDS.OKAY, 42, header.arg1));
                socket.write(adb.encodePacket(adb.COMMANDS.WRTE, 42, header.arg1, Buffer.from('done\n')));

                // As vd_appinstall does, the daemon keeps talking after the line that says it worked.
                chatter = setInterval(() => socket.write(
                    adb.encodePacket(adb.COMMANDS.WRTE, 42, header.arg1, Buffer.from('still here\n'))), 20);
                return;
            }

            if (header.command === adb.COMMANDS.CLSE) {
                told++;
                if (chatter) clearInterval(chatter);
            }
        });
    }, async (port) => {
        const output = await sdb.withSession({ port, timeout: 2000 }, (session) =>
            session.exec('shell:0 vd_appinstall', { timeout: 2000, until: (o) => /done/.test(o) }));

        await wait(100);

        check('a command that stops on its own gives the stream back instead of leaving it running',
            told === 1 && output === 'done\n', `${told} CLSE, ${JSON.stringify(output)}`);

        sdb.release();
        if (chatter) clearInterval(chatter);
    });

    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error('Harness error:', err);
    process.exit(1);
});
