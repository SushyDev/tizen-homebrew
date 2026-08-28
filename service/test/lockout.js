'use strict';

// Once the relay exists, guessing the PIN means shell access on the TV. A
// 6-digit PIN is only 10^6 tries, which is minutes for a script on the LAN,
// so repeated failures have to stop being cheap. This pins that behaviour.

const http = require('http');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = Number(process.env.HOMEBREW_PORT) || 8422;
process.env.HOMEBREW_PORT = String(PORT);
process.env.HOMEBREW_CONFIG_DIR = fs.mkdtempSync(`${os.tmpdir()}/homebrew-lockout-`);

const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
}

function get(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve(body));
        }).on('error', reject);
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

function next(conn, type, timeout) {
    const deadline = Date.now() + (timeout || 4000);
    return new Promise((resolve, reject) => {
        (function poll() {
            for (let i = 0; i < conn.inbox.length; i++) {
                if (conn.inbox[i].type === type) return resolve(conn.inbox.splice(i, 1)[0]);
            }
            if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${type}`));
            setTimeout(poll, 20);
        })();
    });
}

function send(conn, type, payload) {
    conn.socket.send(JSON.stringify({ type, payload: payload || {} }));
}

require('../src/main.js');

setTimeout(() => {
    let pin;
    let conn;

    get('/pin')
        .then((body) => {
            pin = JSON.parse(body).pin;
            return open();
        })
        .then((c) => {
            conn = c;
            return next(conn, 'hello');
        })
        .then(() => {
            // Five wrong PINs, which is the configured limit.
            const wrong = pin === '000000' ? '111111' : '000000';
            let chain = Promise.resolve();
            for (let i = 0; i < 5; i++) {
                chain = chain.then(() => {
                    send(conn, 'hello', { pin: wrong });
                    return next(conn, 'hello');
                });
            }
            return chain;
        })
        .then(() => {
            // The sixth attempt should be locked out — even with the RIGHT pin,
            // which is the property that actually matters.
            send(conn, 'hello', { pin });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('further attempts are locked out after 5 failures',
                msg.payload.code === 'lockedOut', JSON.stringify(msg.payload));
            check('lockout message says how long to wait',
                /\d+s/.test(msg.payload.message || ''), msg.payload.message);

            // And the correct PIN still does not get through while locked.
            send(conn, 'hello', { pin });
            return next(conn, 'error');
        })
        .then((msg) => {
            check('a correct PIN is rejected while locked out',
                msg.payload.code === 'lockedOut', JSON.stringify(msg.payload));

            const failed = results.filter((r) => !r).length;
            console.log(`\n${results.length - failed}/${results.length} checks passed.`);
            process.exit(failed ? 1 : 0);
        })
        .catch((err) => {
            console.error('Harness error:', err.message);
            process.exit(1);
        });
}, 400);
