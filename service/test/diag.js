'use strict';

const diag = require('../src/http/diag.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const lines = [
    { t: 10, facility: 'auth', level: 'info', text: 'pairing pin 482913 — kept across restarts' },
    { t: 20, facility: 'sdb', level: 'warn', text: 'loopback 127.0.0.1:26101 is not usable (refused)' },
    { t: 30, facility: 'pkg', level: 'err', text: 'install failed[118, -22]' }
];

const report = diag.bundle({
    build: '0.2.2+abc',
    startedAt: '2026-11-07T00:00:00.000Z',
    runtime: 'node v20.18.1',
    device: { onTv: true, ready: false, reason: 'refused', duid: 'SECRET-DUID', platformVersion: '10.0' },
    hasCertificates: false,
    addresses: ['192.168.1.20 (wlan0)'],
    lines,
    secret: '482913'
});

const text = JSON.stringify(report);

check('the pairing code never leaves the TV', text.indexOf('482913') === -1, text);
check('nor does the DUID', text.indexOf('SECRET-DUID') === -1, text);
check('an unusable sdb is said in plain words', report.findings.some((found) => found.tone === 'bad' && /Host PC IP/.test(found.text)),
    JSON.stringify(report.findings));
check('the newest error is named', report.findings.some((found) => /install failed/.test(found.text)), JSON.stringify(report.findings));

const page = diag.page(report, 'https://support.example');
check('the page offers sending when a support server is set', /id="send"/.test(page), 'no send button');
check('and only then', !/id="send"/.test(diag.page(report, '')), 'send button without a server');
check('a closing script tag in the log cannot break out of the page',
    diag.page(Object.assign({}, report, { log: [{ t: 0, facility: 'x', level: 'info', text: '</script><b>' }] }), '').indexOf('</script><b>') === -1,
    'unescaped');

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
