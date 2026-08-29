'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.HOMEBREW_PORT) || 8399;
process.env.HOMEBREW_PORT = String(PORT);

const os = require('os');
const fs = require('fs');
process.env.HOMEBREW_CONFIG_DIR = fs.mkdtempSync(`${os.tmpdir()}/homebrew-test-`);

const results = [];
function check(name, condition, detail) {
    results.push({ name, ok: !!condition, detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail}`}`);
}

function get(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function post(path, pin) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port: PORT, path, method: 'POST',
            headers: pin ? { 'x-homebrew-pin': pin } : {}
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });

        request.on('error', reject);
        request.end();
    });
}

function open() {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const inbox = [];
        socket.on('message', (raw) => inbox.push(JSON.parse(raw)));
        socket.on('open', () => resolve({ socket, inbox }));
        socket.on('error', reject);
    });
}

function send(conn, type, payload) {
    conn.socket.send(JSON.stringify({ type, payload: payload || {} }));
}

function next(conn, type, timeout) {
    const deadline = Date.now() + (timeout || 4000);
    return new Promise((resolve, reject) => {
        (function poll() {
            for (let i = 0; i < conn.inbox.length; i++) {
                if (conn.inbox[i].type === type) return resolve(conn.inbox.splice(i, 1)[0]);
            }
            if (Date.now() > deadline) return reject(new Error(`Timed out waiting for "${type}".`));
            setTimeout(poll, 25);
        })();
    });
}

require(process.env.HOMEBREW_ENTRY === 'dist' ? '../dist/index.js' : '../src/main.js');

setTimeout(() => {
    let pin;
    let conn;

    get('/health')
        .then((res) => {
            check('GET /health responds', res.status === 200, `status ${res.status}`);
            return get('/pin');
        })
        .then((res) => {
            pin = JSON.parse(res.body).pin;
            check('GET /pin serves the PIN over loopback', res.status === 200 && /^\d{6}$/.test(pin), res.body);

            // Deliberately wrong: the right one would end this test run along with the service.
            return post('/shutdown', pin === '000000' ? '111111' : '000000');
        })
        .then((res) => {
            check('POST /shutdown checks the PIN before it exits', res.status === 403, `status ${res.status}`);
            return open();
        })
        .then((c) => {
            conn = c;
            return next(conn, 'hello');
        })
        .then((msg) => {
            check('server asks for a PIN on connect', msg.payload.needsPin === true, JSON.stringify(msg));

            send(conn, 'getState');
            return next(conn, 'error');
        })
        .then((msg) => {
            check('unpaired request is rejected', msg.payload.code === 'unauthorized', JSON.stringify(msg.payload));

            send(conn, 'hello', { pin: '000000' === pin ? '111111' : '000000' });
            return next(conn, 'hello');
        })
        .then((msg) => {
            check('wrong PIN is rejected', msg.payload.ok === false, JSON.stringify(msg.payload));

            send(conn, 'hello', { pin });
            return next(conn, 'hello');
        })
        .then((msg) => {
            check('correct PIN pairs the client', msg.payload.ok === true, JSON.stringify(msg.payload));
            return next(conn, 'relayState');
        })
        .then((msg) => {
            check('relay is reported off by default', msg.payload.enabled === false, JSON.stringify(msg.payload));
            return next(conn, 'state');
        })
        .then((msg) => {
            check('state follows a successful pairing', msg.payload.reason === 'notOnTv', JSON.stringify(msg.payload));

            conn.socket.send('{ not json');
            return next(conn, 'error');
        })
        .then((msg) => {
            check('malformed JSON is reported', msg.payload.code === 'badMessage', JSON.stringify(msg.payload));

            send(conn, 'install', { source: 'ftp', ref: 'x' });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('unknown install source is rejected', msg.payload.code === 'badMessage', JSON.stringify(msg.payload));

            send(conn, 'install', { source: 'url', ref: 'http://insecure/a.wgt' });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('plain-http package URL is refused', msg.payload.code === 'badMessage', JSON.stringify(msg.payload));

            send(conn, 'relayExec', { id: 'r1', command: 'ls /' });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('relayExec is refused while the relay is off',
                msg.payload.code === 'relayDisabled', JSON.stringify(msg.payload));

            send(conn, 'relayExec', { id: 'r2' });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('relayExec without a command is rejected',
                msg.payload.code === 'badMessage', JSON.stringify(msg.payload));

            send(conn, 'listDir', { path: '/definitely/not/here' });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('unreadable directory is reported', msg.payload.code === 'notFound', JSON.stringify(msg.payload));

            const config = require('../src/config.js');
            config.update({ author: 'a', distributor: 'b' });
            send(conn, 'install', { source: 'file', ref: '/nope.wgt' });
            return next(conn, 'error').then(() => config.hasCertificates());
        })
        .then((stillHasCerts) => {
            check('a failed install does NOT wipe stored certificates', stillHasCerts === true,
                'certificates were cleared, which is the reference implementation bug');
            require('../src/config.js').clear();

            const failed = results.filter((r) => !r.ok).length;
            console.log(`\n${results.length - failed}/${results.length} checks passed.`);
            process.exit(failed ? 1 : 0);
        })
        .catch((err) => {
            console.error('\nHarness error:', err.message);
            process.exit(1);
        });
}, 400);
