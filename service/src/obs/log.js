'use strict';

// The service's own log, in the shape Unix has printed one since dmesg.
//
// Debugging this service on a television is otherwise close to impossible:
// sdbd runs a command allowlist that excludes every log tool, and pulling
// files off the device is refused outright. So the log has to come *out* —
// over HTTP, to the TV's own screen and to any phone that asks for it. That
// makes it a surface people read rather than a debugging aid, and it is
// written like one.
//
// One record is dmesg's line:
//
//     [    12.345678] pkg: staged 5.4 MB to /home/owner/share/tmp/…/package.wgt
//
// The timestamp is monotonic since this service started, which is the only
// clock that means anything here — the service outlives its own reinstall and
// long outlives the page showing it, and a wall clock on a TV can step by
// hours when it finally reaches an NTP server. Six decimals because they are
// real: process.hrtime() is nanosecond-resolution, and the gaps between lines
// are most of what a log is for.
//
// The facility is which part of the service is talking. It is the thing that
// makes a thousand lines skimmable, and the list of them below doubles as a
// map of the service.
//
// Severity is carried as a field rather than spelled into the message, so the
// screen can colour it and a reader can count the problems without reading
// them.

const MAX_LINES = 1000;
const MAX_LINE = 2000;

// dmesg has eight severities and this has five, because the other three would
// be a lie: nothing here is an emergency, an alert, or a critical fault of the
// machine. `ok` is not one of dmesg's at all — it is here because half of what
// this log reports is a thing that *worked*, and a log where success and
// noise look identical makes a person read every line to find the one that
// matters.
const LEVELS = ['debug', 'info', 'ok', 'warn', 'err'];

// Every part of the service that talks, named once. A fixed set rather than
// free strings: a mistyped facility is a category nobody will ever think to
// look under.
const Facility = {
    SVC:   'svc',     // the service itself: starting, listening, exiting
    NET:   'net',     // addresses, ports, binding
    HTTP:  'http',    // one line per request, as an access log
    SOCK:  'sock',    // phones: connecting, talking, going away
    AUTH:  'auth',    // the PIN: pairing, refusals, lockouts
    DEV:   'dev',     // the television: platform version, developer mode
    SDB:   'sdb',     // loopback sdb: sessions and the commands run over them
    PKG:   'pkg',     // packages: fetched, verified, staged, installed
    CAT:   'cat',     // the catalogue
    RELAY: 'relay',   // the command relay
    CFG:   'cfg'      // stored configuration
};

// Node 4.4.3 is the floor on Tizen 3 and has no padStart.
const padLeft = (text, width) => (text.length >= width
    ? text
    : new Array(width - text.length + 1).join(' ') + text);

/** dmesg's own line, so the platform's log reads the way the TV screen does. */
const format = (record) => `[${padLeft((record.t / 1000).toFixed(6), 12)}] ${record.facility}: ${record.text}`;

// One console wrapper per *process*, however many times this module is loaded.
//
// Tizen reloads the service into the same process on a reinstall. That is
// measured, not assumed: after pushing a new build, the service reported a
// startedAt 49 seconds old while process.uptime() still reached back half an
// hour, to the second the previous instance started. So this module gets a
// second life alongside the first, its timers and its ring buffer included.
//
// Wrapping the console again in that second life would stack a layer per
// reinstall — each one recording into a ring nobody can reach any more, and
// each one printing through its predecessor rather than through the real
// console. Ten pushes in an afternoon would leave ten of them.
//
// So the wrapper is installed once and writes to whichever recorder is
// current, and the console as it was before any of this is kept beside it.
const SINK = (() => {
    if (console.__homebrewSink) return console.__homebrewSink;

    const sink = {
        // Set by the newest recorder that asked to capture; see startRecording.
        record: null,
        pristine: ['log', 'info', 'warn', 'error']
            .reduce((kept, name) => ({ ...kept, [name]: console[name] }), {})
    };

    ['log', 'info', 'warn', 'error'].forEach((name) => {
        console[name] = (...values) => {
            // Recording must never be the reason a log call fails.
            try {
                if (sink.record) sink.record(name, values);
            } catch (e) { /* keep going */ }

            sink.pristine[name].apply(console, values);
        };
    });

    // A crash after startup is exactly what this exists to catch. Routed
    // through the wrapper above rather than recorded directly, so it is
    // written once by the recorder that is current — and, like the wrapper,
    // attached once however many times the service is reloaded. Otherwise the
    // fifth reinstall would print the same stack trace five times.
    process.on('uncaughtException', (error) => {
        console.error('uncaught exception:', error && error.stack ? error.stack : error);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('unhandled rejection:', reason && reason.stack ? reason.stack : reason);
    });

    console.__homebrewSink = sink;

    return sink;
})();

/**
 * Starts the log, and returns the writer and the reader for it.
 *
 * `debug` records are dropped unless asked for. The only thing that logs at
 * that level is the TV page polling its own service — which is the log being
 * *read*, not the system doing anything, and recording it would make every
 * poll produce a line that the next poll then delivers, forever.
 *
 * `print` is where lines go on their way out, and `capture` whether the
 * console is wrapped. Both exist for the test, which needs a recorder that
 * neither prints into the suite's own output nor records the suite's own
 * `console.log` calls as service events.
 */
const startRecording = (options) => {
    const settings = options || {};
    const max = settings.max || MAX_LINES;
    const keepDebug = settings.debug !== undefined ? !!settings.debug : !!process.env.HOMEBREW_DEBUG;
    const capture = settings.capture !== undefined ? !!settings.capture : true;

    const lines = [];
    let sequence = 0;

    // Monotonic where the platform offers it. hrtime is in Node 4, which is
    // the oldest runtime this service has to start on.
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

    /**
     * Writes a message to the ring, as one record per line of it.
     *
     * dmesg has no multi-line record and neither does this — the header at the
     * top of this file promises that one record is one line, and every reader
     * of this log is built on it. A stack trace arrives here as a single
     * string with newlines in it, and it is the one thing that ever broke that
     * promise.
     *
     * It broke it expensively. The television draws the log as a grid whose
     * rows it counts to find how many fit, and a record eight lines tall made
     * that count disagree with itself: nine rows fit when six were drawn, six
     * fit when nine were. Pressing `show logs` recursed between the two until
     * the stack ran out. See `fit` in ui/src/tv.js, which no longer trusts the
     * count to settle either.
     *
     * Returns every record it wrote, because the caller prints them.
     */
    const record = (level, facility, text) => {
        if (level === 'debug' && !keepDebug) return [];

        // Trailing newlines are punctuation on the message rather than empty
        // lines somebody meant to write; interior ones are kept, because a
        // blank line in the middle of a stack trace is in the stack trace.
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

    /**
     * Writes a message, and prints every line it became.
     *
     * Printing goes through the console function matching the severity, so the
     * platform's own log keeps the distinction too — on a TV that output is
     * the only copy that survives the service dying.
     */
    const write = (level, facility, values) => {
        try {
            const written = record(level, facility, values.map(render).join(' '));

            const print = level === 'err' ? SINK.pristine.error
                : level === 'warn' ? SINK.pristine.warn
                : SINK.pristine.log;

            // A message that became several records is printed as several
            // lines, each stamped and named — so the platform's own log reads
            // the way the television's does rather than keeping a shape this
            // one has given up.
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

    /** A writer bound to one facility, for a module that only ever uses one. */
    log.on = (facility) => LEVELS.reduce((bound, level) => {
        bound[level] = (...values) => write(level, facility, values);
        return bound;
    }, {});

    // Anything that still logs the old way — a dependency, a stack trace from a
    // crash — lands under `svc` rather than disappearing. Claiming the sink is
    // how a reloaded service takes the console back from the instance it
    // replaced, which is the only thing that stops the old ring collecting
    // lines nobody will ever read.
    if (capture) {
        SINK.record = (name, values) => record(
            name === 'error' ? 'err' : name === 'warn' ? 'warn' : 'info',
            Facility.SVC,
            values.map(render).join(' ')
        );
    }

    /** Lines newer than `since`, so a client can poll without re-reading. */
    const since = (sequenceNumber) => {
        const from = Number(sequenceNumber) || 0;
        return lines.filter((line) => line.seq > from);
    };

    /** How many of each severity are still in the ring. */
    const counts = () => lines.reduce((tally, line) => {
        tally[line.level] = (tally[line.level] || 0) + 1;
        return tally;
    }, {});

    return { log, since, counts, format, uptime: elapsed };
};

module.exports = { startRecording, format, Facility, LEVELS, MAX_LINES };
