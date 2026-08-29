'use strict';

// The service's own log, in dmesg's shape, because sdbd's allowlist excludes every log tool on the TV.

const MAX_LINES = 1000;
const MAX_LINE = 2000;

const LEVELS = ['debug', 'info', 'ok', 'warn', 'err'];

const Facility = {
    SVC:   'svc',
    NET:   'net',
    HTTP:  'http',
    SOCK:  'sock',
    AUTH:  'auth',
    DEV:   'dev',
    SDB:   'sdb',
    PKG:   'pkg',
    CAT:   'cat',
    RELAY: 'relay',
    CFG:   'cfg'
};

// Node 4.4.3 is the floor on Tizen 3 and has no padStart.
const padLeft = (text, width) => (text.length >= width
    ? text
    : new Array(width - text.length + 1).join(' ') + text);

const format = (record) => `[${padLeft((record.t / 1000).toFixed(6), 12)}] ${record.facility}: ${record.text}`;

// Tizen reloads the service into the same process, so the console is wrapped once per process.
const SINK = (() => {
    if (console.__homebrewSink) return console.__homebrewSink;

    const sink = {
        record: null,
        pristine: ['log', 'info', 'warn', 'error']
            .reduce((kept, name) => ({ ...kept, [name]: console[name] }), {})
    };

    ['log', 'info', 'warn', 'error'].forEach((name) => {
        console[name] = (...values) => {
            try {
                if (sink.record) sink.record(name, values);
            } catch (e) {}

            sink.pristine[name].apply(console, values);
        };
    });

    // Attached once however often the service reloads, or the fifth reinstall prints five traces.
    process.on('uncaughtException', (error) => {
        console.error('uncaught exception:', error && error.stack ? error.stack : error);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('unhandled rejection:', reason && reason.stack ? reason.stack : reason);
    });

    console.__homebrewSink = sink;

    return sink;
})();

// `print` and `capture` exist for the test, which records neither into nor from the suite's own console.
const startRecording = (options) => {
    const settings = options || {};
    const max = settings.max || MAX_LINES;
    const keepDebug = settings.debug !== undefined ? !!settings.debug : !!process.env.HOMEBREW_DEBUG;
    const capture = settings.capture !== undefined ? !!settings.capture : true;

    const lines = [];
    let sequence = 0;

    // hrtime is in Node 4, which is the oldest runtime this service has to start on.
    const origin = process.hrtime ? process.hrtime() : null;
    const startedWall = Date.now();

    const elapsed = () => {
        if (!origin) return Date.now() - startedWall;

        const delta = process.hrtime(origin);
        return delta[0] * 1000 + delta[1] / 1e6;
    };

    const render = (value) => {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.stack || value.message;

        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    };

    // One record is one line: a multi-line one made the TV's row count recurse until the stack ran out.
    const record = (level, facility, text) => {
        if (level === 'debug' && !keepDebug) return [];

        return String(text).replace(/[\r\n]+$/, '').split(/\r?\n/).map((one) => {
            const line = {
                seq: ++sequence,
                t: elapsed(),
                at: new Date().toISOString(),
                level,
                facility,
                text: one.length > MAX_LINE ? `${one.slice(0, MAX_LINE)}…` : one
            };

            lines.push(line);
            while (lines.length > max) lines.shift();

            return line;
        });
    };

    const write = (level, facility, values) => {
        try {
            const written = record(level, facility, values.map(render).join(' '));

            const print = level === 'err' ? SINK.pristine.error
                : level === 'warn' ? SINK.pristine.warn
                : SINK.pristine.log;

            written.forEach((line) => (settings.print
                ? settings.print(format(line), line)
                : print.call(console, format(line))));
        } catch (e) {
            // Logging must never be the reason something fails.
        }
    };

    const log = {};

    LEVELS.forEach((level) => {
        log[level] = (facility, ...values) => write(level, facility, values);
    });

    log.on = (facility) => LEVELS.reduce((bound, level) => {
        bound[level] = (...values) => write(level, facility, values);
        return bound;
    }, {});

    // Anything still logging the old way lands under `svc`; claiming the sink is how a reload takes it back.
    if (capture) {
        SINK.record = (name, values) => record(
            name === 'error' ? 'err' : name === 'warn' ? 'warn' : 'info',
            Facility.SVC,
            values.map(render).join(' ')
        );
    }

    const since = (sequenceNumber) => {
        const from = Number(sequenceNumber) || 0;
        return lines.filter((line) => line.seq > from);
    };

    const counts = () => lines.reduce((tally, line) => {
        tally[line.level] = (tally[line.level] || 0) + 1;
        return tally;
    }, {});

    return { log, since, counts, format, uptime: elapsed };
};

module.exports = { startRecording, format, Facility, LEVELS, MAX_LINES };
