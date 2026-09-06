'use strict';

// Finding the set, so nobody has to go looking in their router: every Samsung television answers
// http://<ip>:8001/api/v2/ with its model, and the local /24 is one sweep.

const net = require('net');
const { networkInterfaces } = require('os');
const { createInterface } = require('readline');

const ui = require('./ui.js');
const { describe, DEVICE_API_PORT } = require('./tv.js');

// A /24's worth in flight at once, so each subnet costs about one timeout rather than several.
const PROBE_TIMEOUT = 1500;
const AT_ONCE = 254;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const isAddress = (text) => {
    const match = IPV4.exec(text);
    return Boolean(match) && match.slice(1).every((part) => Number(part) < 256);
};

const asNumber = (ip) => ip.split('.').reduce((total, part) => (total * 256) + Number(part), 0);

// Only the /24 each interface sits in: a /16 is 65k probes, and a set on a different one is
// something the operator can type.
const subnets = () => {
    const interfaces = networkInterfaces();
    const prefixes = [];
    const mine = [];

    for (const name in interfaces) {
        for (const entry of interfaces[name] || []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;

            mine.push(entry.address);

            const prefix = entry.address.split('.').slice(0, 3).join('.');
            if (prefixes.indexOf(prefix) === -1) prefixes.push(prefix);
        }
    }

    return { prefixes, mine };
};

const pool = async (items, worker) => {
    const found = [];
    let next = 0;

    const run = async () => {
        while (next < items.length) {
            const at = next;
            next += 1;

            const result = await worker(items[at]);
            if (result) found.push(result);
        }
    };

    const runners = [];
    for (let n = 0; n < Math.min(AT_ONCE, items.length); n += 1) runners.push(run());

    await Promise.all(runners);

    return found;
};

// fetch costs far more than the network does: a /24 asked with it takes ten seconds where the same
// range knocked on by hand takes one and a half. So the sweep opens a socket at every address and
// only asks the few that answered what they are.
const knock = (ip) => new Promise((answered) => {
    const socket = net.connect({ host: ip, port: DEVICE_API_PORT });

    const settle = (open) => {
        socket.destroy();
        answered(open ? ip : null);
    };

    socket.setTimeout(PROBE_TIMEOUT, () => settle(false));
    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
});

const sweep = async () => {
    const { prefixes, mine } = subnets();

    const addresses = prefixes.reduce((all, prefix) => {
        for (let host = 1; host < 255; host += 1) {
            const ip = `${prefix}.${host}`;
            if (mine.indexOf(ip) === -1) all.push(ip);
        }
        return all;
    }, []);

    // Something else may sit on 8001, so the answer still has to look like a television.
    const listening = await pool(addresses, knock);

    const televisions = (await Promise.all(listening.map(async (ip) => {
        const device = await describe(ip);
        return device ? { ip, device } : null;
    }))).filter(Boolean);

    return {
        prefixes,
        televisions: televisions.sort((a, b) => asNumber(a.ip) - asNumber(b.ip))
    };
};

const ENTITIES = { quot: '"', apos: '\'', '#39': '\'', amp: '&', lt: '<', gt: '>' };

// A set named `65" OLED` reports it as `65&quot; OLED`.
const plain = (text) => String(text).replace(/&(#39|quot|apos|amp|lt|gt);/g, (whole, name) => ENTITIES[name] || whole);

const nameOf = (device) => plain(device.name || device.modelName || device.model || 'Samsung TV');

// Developer Mode is the next thing that would fail, so it is worth saying before anything is chosen.
const modeOf = (device) => (device.developerMode === '1' ? 'developer mode on' : 'developer mode OFF');

// The model tells two sets with the same name apart, and it is what a forum post would ask for.
const detailOf = (device) => [device.modelName, modeOf(device)].filter(Boolean).join(' \u00b7 ');

const askOnce = (rl, text) => new Promise((resolve) => {
    const closed = () => resolve(null);

    rl.once('close', closed);
    rl.question(text, (answer) => {
        rl.removeListener('close', closed);
        resolve(answer);
    });
});

const listed = (televisions) => {
    televisions.forEach((found, at) => {
        const number = ui.style.bold(String(at + 1).padStart(3));
        ui.note(`${number}  ${nameOf(found.device).padEnd(24)} ${found.ip.padEnd(16)} ${ui.style.dim(detailOf(found.device))}`);
    });
};

const ask = async (televisions) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const prompt = televisions.length > 1
        ? `Which one? 1-${televisions.length}, or an address: `
        : (televisions.length === 1 ? 'Enter to use it, or another address: ' : 'Address of the TV: ');

    try {
        for (;;) {
            const answer = await askOnce(rl, `\n${prompt}`);

            if (answer === null) return null;

            const said = answer.trim();

            if (!said) {
                if (televisions.length === 1) return televisions[0].ip;
                if (!televisions.length) return null;

                ui.warn(`Pick one, 1 to ${televisions.length}, or type an address.`);
                continue;
            }

            if (televisions.length && /^\d{1,3}$/.test(said)) {
                const chosen = Number(said);

                if (chosen >= 1 && chosen <= televisions.length) return televisions[chosen - 1].ip;

                ui.warn(`There is no ${chosen} in that list — pick 1 to ${televisions.length}, or type an address.`);
                continue;
            }

            if (!isAddress(said)) {
                ui.warn(`${said} is not an address.`);
                continue;
            }

            ui.note(ui.style.dim(`  asking ${said}...`));

            const device = await describe(said, 5000);

            if (!device) {
                ui.warn(`Nothing answered on ${said}:8001 — is that the TV, and is it on?`);
                continue;
            }

            ui.ok('found', `${nameOf(device)} \u00b7 ${detailOf(device)}`);

            return said;
        }
    } finally {
        rl.close();
    }
};

// The address, or null when there is nobody to ask — the caller says what to do about that.
const choose = async () => {
    if (!process.stdin.isTTY) return null;

    const where = subnets().prefixes.map((prefix) => `${prefix}.0/24`).join(', ') || 'this machine';

    ui.note(`  ${ui.style.dim(`looking for televisions on ${where}...`)}`);

    const { televisions } = await sweep();

    if (!televisions.length) {
        ui.fail('no televisions', ui.style.dim(where));
        ui.blank();
        ui.note('  Nothing answered. A set has to be on, and on the same network as this');
        ui.note('  machine — a guest network or a VPN is enough to hide it.');
    } else {
        ui.ok(televisions.length === 1 ? 'found a television' : `found ${televisions.length} televisions`, where);
        ui.blank();
        listed(televisions);
    }

    return ask(televisions);
};

module.exports = { choose, sweep, isAddress, nameOf, modeOf, detailOf };
