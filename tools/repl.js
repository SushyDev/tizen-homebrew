'use strict';

// A prompt on the television.
//
//   npm run repl -- 192.168.2.106
//   npm run repl -- 192.168.2.106 --pin 483920
//   npm run repl -- 127.0.0.1 --port 8395     (against a local dev:service)
//
// Every line is evaluated inside the running service. Only a developer build
// answers, and one pairs with 000000, which is what this assumes.
//
//   .inspect   open Node's inspector on the TV and print the DevTools URL
//   .names     what is in scope
//   .exit      leave
//
// Multi-statement input needs an explicit `return` for a value.

const { createInterface } = require('readline');

const ui = require('./ui.js');
const { parse } = require('./args.js');

const DEFAULT_PORT = 8091;
const DEFAULT_PIN = '000000';

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true });

const post = (host, port, path, pin, body, headers) => new Promise((resolve, reject) => {
    const request = require('http').request({
        host,
        port,
        path,
        method: 'POST',
        headers: Object.assign({ 'x-homebrew-pin': pin, 'content-type': 'text/plain' }, headers || {}),
        timeout: 30000
    }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
            try {
                resolve({ status: response.statusCode, body: JSON.parse(text) });
            } catch (e) {
                resolve({ status: response.statusCode, body: { raw: text } });
            }
        });
    });

    request.on('timeout', () => { request.destroy(); reject(friendly(`${host} did not answer in 30s.`)); });
    request.on('error', (error) => reject(friendly(`${host}:${port} — ${error.message}`)));
    request.end(body || '');
});

const explain = (status, body) => {
    if (status === 404) {
        return 'That set is not running a developer build — /dev/eval does not exist on it.\n' +
            '  Build one with `npm run build -- --dev`, then push it.';
    }
    if (status === 403) return `The PIN was refused. ${(body && body.message) || ''}`.trim();
    if (status === 429) return (body && body.message) || 'Locked out for a few minutes.';

    return (body && (body.message || body.raw)) || `HTTP ${status}`;
};

const main = async () => {
    const args = parse(process.argv.slice(2), ['--pin', '--port']);
    const host = args.positionals[0];
    const pin = args.value('--pin') || args.positionals[1] || DEFAULT_PIN;
    const port = Number(args.value('--port')) || DEFAULT_PORT;

    if (!host) throw friendly('Which television?  npm run repl -- <ip> [pin]');

    ui.heading('repl', port === DEFAULT_PORT ? host : `${host}:${port}`);

    const names = await post(host, port, '/dev/eval', pin, 'Object.keys({})');
    if (names.status !== 200) throw friendly(explain(names.status, names.body));

    ui.note(ui.style.dim(`  ${pin === DEFAULT_PIN ? 'developer pin' : 'pin'} accepted · .inspect .names .exit`));
    ui.blank();

    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'tv> ' });

    const handle = async (source) => {
        if (source === '.inspect') {
            const { status, body } = await post(host, port, '/dev/inspect', pin, '');

            if (status !== 200) return ui.fail('inspect', explain(status, body));
            if (!body.ok) return ui.fail('inspect', body.error);

            ui.ok('inspector', body.alreadyOpen ? 'already open' : 'opened');
            // Node reports 0.0.0.0, which no debugger can connect to.
            ui.note(`  ${String(body.url || '').replace(/0\.0\.0\.0|127\.0\.0\.1/, host)}`);
            return ui.note(ui.style.dim(`  or chrome://inspect › Configure › add ${host}:9229`));
        }

        const expression = source === '.names' ? 'Object.keys($).sort()' : source;
        const { status, body } = await post(host, port, '/dev/eval', pin, expression);

        if (status !== 200) return ui.fail('eval', explain(status, body));
        if (body.ok) return process.stdout.write(`${body.value}\n`);

        return ui.fail('threw', body.error);
    };

    // One at a time: a piped script otherwise sends every line before the first answer.
    let queue = Promise.resolve();
    let leaving = false;

    rl.on('line', (line) => {
        const source = line.trim();

        if (!source) return rl.prompt();
        if (source === '.exit') return rl.close();

        rl.pause();

        queue = queue
            .then(() => handle(source))
            .catch((error) => ui.fail('repl', error.message))
            .then(() => {
                if (leaving) return;
                rl.resume();
                rl.prompt();
            });
    });

    rl.on('close', () => {
        leaving = true;
        queue.then(() => {
            ui.blank();
            process.exit(0);
        });
    });

    rl.prompt();
};

main().catch((error) => ui.crash(error));
