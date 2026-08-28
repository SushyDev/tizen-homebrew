import './app.css';

import { createStore } from './core/store.js';
import { mount, delegate } from './core/view.js';
import { remote, KEY } from './core/remote.js';
import { sea } from './scene/sea.js';
import { theme } from './scene/theme.js';
import { masthead, connect, status, log, overlay, deck, windowOf } from './views/television.js';

// The channel, on the television.
//
// Read top to bottom: what is on screen, what the remote does, and what the
// service is asked. Everything visible is a pure function of the store below,
// so nothing in this file writes to the DOM — it moves state and lets the
// paint follow.

const PORT = 8091;

// Off a television there is no `tizen` object at all, which is what makes
// this page openable in a browser. Everything that touches the platform is
// decided from this one test, including where the service is: on the TV the
// page is a widget on the local filesystem and has to name the loopback
// origin, and in a browser it is served by whatever is standing in for the
// service, so its own origin is right.
const platform = typeof tizen === 'undefined' ? null : tizen;
const application = platform ? platform.application.getCurrentApplication() : null;

const BASE = application ? `http://127.0.0.1:${PORT}` : '';

// Samsung's colour keys are not delivered to a web app unless the app asks
// for them by name first.
const RED = 403;

// `view` is which screen the television is on: the channel itself, the log
// console, or the credits. `from` is the first row visible in whichever of
// the last two is open — the overlays show a window onto a list rather than
// scrolling one. See views/television.js.
const store = createStore({
    url: null,
    pin: null,
    ready: null,
    build: null,
    lines: [],
    attempts: 0,
    view: 'main',
    from: 0,
    rows: null,
    themeOn: false
});

const started = Date.now();

// ── The log ───────────────────────────────────────────────────────────
//
// Almost everything on this screen was written by the service, not by this
// page: what it bound to, which phone paired, what a package weighed, what
// the television said about installing it. The page collects that over
// `GET /logs` and adds the handful of things only it can know — that it asked
// the platform to launch the service, that the service has not answered yet,
// that this page itself threw.
//
// Both kinds are stamped on one clock: the service's uptime. dmesg is
// monotonic since boot, and the equivalent here is monotonic since the
// service started, because the service is the thing being reported on. It
// also outlives this page — it survives its own reinstall — so a page-local
// clock would restart the log at zero every time somebody opened the app.

// Deep enough that the console is worth opening after something has gone
// wrong, since the interesting line is rarely the last one. The service keeps
// the same number, so this is the whole of what it can offer.
const MAX_LINES = 1000;

// The service's uptime, in milliseconds, as of this page's own clock. Null
// until the service first answers — see `stamp`.
let clockOffset = null;

/**
 * When a page-local event happened, on the service's clock.
 *
 * Before the service has ever answered there is no such clock, so the page's
 * own elapsed time stands in and the line is marked. The moment the offset
 * arrives, every marked line is restamped — otherwise a page that launched a
 * service which had already been running for an hour would show its own first
 * lines at +0.1s and the service's next line at +3600s.
 */
const stamp = () => (clockOffset === null
    ? { t: Date.now() - started, estimated: true }
    : { t: Date.now() - started + clockOffset, estimated: false });

const restamp = (lines) => lines.map((line) => (line.estimated
    ? { ...line, t: line.t + clockOffset, estimated: false }
    : line));

// The order lines were added in, which is the tie-break below.
let arrivals = 0;

/**
 * Adds lines to the log, in the order they happened.
 *
 * Two sources write here — the service, a second at a time in batches, and
 * this page, whenever something happens to it — so appending alone would put
 * a page event written at +7s above a service event from +0.04s that simply
 * arrived later. They are sorted instead.
 *
 * The comparator falls back to arrival order, which makes it a total order:
 * dozens of service lines legitimately share a millisecond, and a sort that
 * had to call them equal would be free to shuffle a boot sequence — Chromium
 * 63's sort is not stable, and this is a television.
 *
 * The console follows the newest line only while it is already parked there —
 * scroll up to read something and it stays where you put it, which is the
 * whole point of being able to scroll at all. When the buffer overflows, the
 * window moves down with the rows it was showing rather than sliding a line
 * further into the past.
 */
const append = (incoming, restamped = false) => store.update((state) => {
    if (incoming.length === 0 && !restamped) return {};

    const numbered = incoming.map((entry) => ({ ...entry, n: ++arrivals }));

    const kept = (restamped ? restamp(state.lines) : state.lines)
        .concat(numbered)
        .sort((a, b) => (a.t - b.t) || (a.n - b.n))
        .slice(-MAX_LINES);

    const { rows } = windowOf({ ...state, view: 'logs' });
    const following = state.from >= state.lines.length - rows;
    const dropped = state.lines.length + incoming.length - kept.length;

    if (state.view !== 'logs') return { lines: kept };

    return {
        lines: kept,
        from: Math.max(0, following ? kept.length - rows : state.from - dropped)
    };
});

/** One line from this page. The service writes its own. */
const say = (text, level = 'info') => append([{ ...stamp(), facility: 'ui', level, text }]);

window.onerror = (message, _source, line) => say(`page error: ${message} (line ${line})`, 'err');

// ── The scene ─────────────────────────────────────────────────────────

// No pointer on this page: every pointer event a television produces is
// synthetic, and popping bubbles under a cursor nobody is aiming would look
// like a fault rather than a feature. The remote pops them instead.
const water = sea({ pointer: false });

const channel = theme({
    onState: ({ playing }) => store.update({ themeOn: playing })
});

// ── Asking the service ────────────────────────────────────────────────

const ask = (path) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', BASE + path, true);
    request.timeout = 8000;

    request.onload = () => {
        try {
            resolve(JSON.parse(request.responseText));
        } catch (e) {
            reject(new Error(`${path} did not return JSON`));
        }
    };

    request.onerror = () => reject(new Error('unreachable'));
    request.ontimeout = () => reject(new Error('timeout'));
    request.send();
});

// ── Leaving ───────────────────────────────────────────────────────────

const leave = () => {
    if (application) return application.exit();
    say('exit: not running on a television', 'warn');
};

// ── The two screens over this one ─────────────────────────────────────

// The console opens at the newest line, which is the one that was on screen
// a moment ago and the reason anybody opened it. The credits open at the top,
// because they are a document.
const open = (view) => store.update((state) => {
    const { rows, total } = windowOf({ ...state, view });

    // `rows` belongs to the pane that is open, and the next one is a
    // different size — so it goes back to the view's own guess and is
    // measured again on the first paint.
    return { view, rows: null, from: view === 'logs' ? Math.max(0, total - rows) : 0 };
});

const close = () => {
    const { view } = store.get();

    store.update({ view: 'main', from: 0, rows: null });

    // Back onto the button that opened it. Landing at the start of the row
    // instead would make leaving a screen feel like being moved.
    keys.focus(view === 'credits' ? 'credits' : 'logs');
};

// Neither overlay scrolls — see views/television.js — so the direction keys
// move a window through the rows instead: a line at a time, or a screenful
// with left and right.
const scroll = (steps, page) => store.update((state) => {
    const { rows, total } = windowOf(state);
    if (!rows) return {};

    const ceiling = Math.max(0, total - rows);
    const next = state.from + steps * (page ? rows : 1);

    return { from: Math.max(0, Math.min(ceiling, next)) };
});

/** Back to the newest line, which is a long way down a thousand-line log. */
const toEnd = () => store.update((state) => {
    const { rows, total } = windowOf(state);

    return rows ? { from: Math.max(0, total - rows) } : {};
});

// ── What the remote does ──────────────────────────────────────────────

const actions = {
    theme: () => channel.toggle(),
    logs: () => open('logs'),
    credits: () => open('credits'),
    close: () => close(),
    pop: () => water.popAll(),
    exit: () => leave()
};

delegate(actions);

const SCROLLS = {
    [KEY.up]:    [-1, false],
    [KEY.down]:  [1, false],
    [KEY.left]:  [-1, true],
    [KEY.right]: [1, true]
};

const keys = remote({
    // Return leaves whatever is on screen: an overlay first, and the app only
    // from the channel itself. A television app that exited from three levels
    // deep would be one no one dares press Return in.
    onBack: () => (store.get().view === 'main' ? leave() : close()),

    onKey: (keyCode) => {
        const { view } = store.get();

        // On the channel the red key pops the bubbles. Over a log a thousand
        // lines deep it is worth more as the way back to the newest one, which
        // is otherwise seventy pages of holding a direction.
        if (keyCode === RED) {
            if (view === 'main') water.popAll(); else toEnd();
            return true;
        }

        // While an overlay is open the directions belong to it. There is
        // nothing else on screen to move between, and the deck it would
        // otherwise search is hidden behind it.
        if (view === 'main' || !SCROLLS[keyCode]) return false;

        scroll(...SCROLLS[keyCode]);
        return true;
    }
});

if (platform && platform.tvinputdevice) {
    try {
        platform.tvinputdevice.registerKey('ColorF0Red');
    } catch (e) {
        say('the red key is not available on this model', 'warn');
    }
}

// ── What is on screen ─────────────────────────────────────────────────

mount(store, { masthead, connect, status, log, overlay, deck });

/**
 * Counts how many rows of the open screen actually fit, and remembers it.
 *
 * This is the one thing on this page that cannot be worked out from state: a
 * row's height depends on the font the television resolved, on how much of
 * the pane the header and legend took, and on whether a long path wrapped.
 * A constant is a guess about all three, and guessing low is what left a band
 * of empty glass under the last line of the log.
 *
 * So the view draws a few rows past the bottom edge — see SPARE — and this
 * counts the ones that came out whole. It reads the DOM and never writes it;
 * the value goes into the store and the paint follows from there like
 * everything else.
 *
 * With rows of one height it settles on the second pass: the count changes
 * what is drawn, the redraw is measured again, and the second answer agrees
 * with the first because there are always spare rows below the fold to be cut
 * off. It is not allowed to *depend* on that, and `offered` below is why.
 */

// Every count this settle has already asked for, and whether the repaint now
// being measured is one this measurement caused.
//
// Measuring the pane and then redrawing it changes what there is to measure,
// so this is a fixed-point iteration — and a fixed point is not guaranteed.
// Rows are only the same height while every line is one line long: a service
// record carrying a stack trace was eight, and the sequence became a cycle
// rather than converging. Nine rows fitted when six were drawn, six fitted
// when nine were, and neither answer was wrong.
//
// Each pass is a synchronous repaint through the store, so a cycle is not a
// flicker — it is this page recursing until the stack ends. On a television
// that killed the app, and pressing `show logs` was how you did it.
//
// So a settle is bounded. Every answer is remembered, and the moment one
// repeats — which is the cycle, announcing itself — the smallest is taken and
// the pass ends. The smallest is the safe end of a cycle: it is the count that
// fits whichever rows are on screen, where the largest overflows the pane it
// was measured against.
let offered = [];
let settling = false;

const fit = () => {
    const pane = document.querySelector('.curtain .feed, .curtain .roll');
    if (!pane) return;

    const edges = pane.getBoundingClientRect();

    // Which edge the rows are anchored to decides which edge they overflow,
    // and therefore which end of them is worth counting. The log fills upward
    // from its newest line and is cut at the top; the credits fill downward
    // and are cut at the bottom. The pane says which it is rather than this
    // being told twice.
    const upward = getComputedStyle(pane).alignContent.indexOf('end') !== -1;

    const rows = Array.prototype.slice.call(pane.querySelectorAll('[data-row]'))
        // A whole pixel of tolerance: a fractional viewport unit can leave a
        // row's edge a hair past the one it exactly meets.
        .filter((row) => {
            const box = row.getBoundingClientRect();
            return upward ? box.top >= edges.top - 1 : box.bottom <= edges.bottom + 1;
        })
        .length;

    if (rows === 0 || rows === store.get().rows) return;

    const settle = (count) => {
        offered.push(count);
        settling = true;

        try {
            store.update({ rows: count });
        } finally {
            settling = false;
        }
    };

    if (offered.indexOf(rows) === -1) return settle(rows);

    const smallest = Math.min.apply(null, offered);
    if (smallest !== store.get().rows) settle(smallest);
};

/** A settle that starts over, for a pane this measurement did not cause. */
const remeasure = () => {
    offered = [];
    fit();
};

// The deck is replaced wholesale on every repaint, so the element holding
// focus is destroyed and an identical one takes its place. This puts the
// light back on it — by name, which is why it survives the swap.
store.subscribe(() => {
    keys.restore();

    // A change from anywhere else — a log line, an overlay opening — is a new
    // pane, and the counts offered against the last one say nothing about it.
    if (settling) fit(); else remeasure();
});

keys.focus('theme');

// Off a television the window is resizable, which is the only thing that
// changes how much fits without the state changing first.
window.addEventListener('resize', remeasure);

// ── Reading the service's log ─────────────────────────────────────────

// Once a second. The service is on the same machine over loopback, so this
// costs a few hundred bytes and a millisecond; and a log that arrives a
// second late while somebody watches an install is a log that looks broken.
const LOG_INTERVAL = 1000;

let sinceSeq = 0;
let lastUptime = 0;
let logAnswered = false;
let logMisses = 0;

const watchLog = async () => {
    try {
        const { lines, uptime } = await ask(`/logs?since=${sinceSeq}`);

        // The service's clock went backwards, so it is not the service that
        // was running a moment ago: it restarted, and its sequence numbers
        // started again from one. Asking from the old sequence would return
        // nothing forever, so the count goes back to zero and the next tick
        // reads the new boot from its beginning.
        //
        // The second of tolerance is for the round trip, which is measured on
        // a television and is not always the millisecond it should be.
        if (uptime + 1000 < lastUptime) {
            sinceSeq = 0;
            lastUptime = 0;
            clockOffset = null;
            say('the service restarted — reading its log from the beginning', 'warn');
            return;
        }

        lastUptime = uptime;

        // This page's own events are stamped on the service's clock, and this
        // is where the two are related. The offset is short by however long
        // the reply took to arrive, which over loopback is a millisecond and
        // is not worth a round-trip correction.
        const first = clockOffset === null;
        clockOffset = uptime - (Date.now() - started);

        if (logMisses >= 3) say('the service is answering again', 'ok');

        logAnswered = true;
        logMisses = 0;

        if (lines.length > 0) sinceSeq = lines[lines.length - 1].seq;

        append(lines.map((line) => ({
            t: line.t,
            facility: line.facility || 'svc',
            level: line.level || 'info',
            text: line.text
        })), first);
    } catch (failure) {
        // Before the service has ever answered, an unanswered poll is simply
        // the service not being up yet — which the startup sequence below is
        // already saying, once, rather than every second.
        if (!logAnswered) return;

        logMisses += 1;
        if (logMisses === 3) say(`the service stopped answering its log (${failure.message})`, 'err');
    }
};

// ── Starting up ───────────────────────────────────────────────────────

// Readiness is polled, never sampled once. sdbd can come up after the app
// does, and a single check taken at that moment would sit on screen saying
// "not ready" long after it had stopped being true.
//
// Nothing here writes to the log: the service reports its own sdb transitions,
// in more detail than this page could, and both saying it would double every
// line.
const watchReadiness = async () => {
    try {
        const state = await ask('/state');
        store.update({ ready: state.sdbReachable });
    } catch (e) {
        // The log already says the service is unreachable.
    }
};

const waitForService = async () => {
    store.update((state) => ({ attempts: state.attempts + 1 }));

    try {
        const { pin, addresses } = await ask('/pin');

        store.update({
            pin,
            url: addresses && addresses.length ? `http://${addresses[0]}:${PORT}` : `port ${PORT}`
        });

        say(`the service answered on port ${PORT}`, 'ok');

        ask('/version').then(({ build }) => store.update({ build }), () => {});

        watchReadiness();
        setInterval(watchReadiness, 5000);
    } catch (failure) {
        const { attempts } = store.get();

        if (attempts === 1) say(`the service is not answering yet (${failure.message})`);
        if (attempts === 12) say('the service is slow to start', 'warn');

        if (attempts >= 60) {
            say(`gave up after ${attempts} attempts`, 'err');
            say(`the background service never opened port ${PORT}`, 'err');
            return;
        }

        setTimeout(waitForService, 500);
    }
};

watchLog();
setInterval(watchLog, LOG_INTERVAL);

say('asking the platform to start the background service');

if (!application) {
    // A browser, not a television. The dev service answers the same routes,
    // so everything below this line behaves identically.
    say('running off-TV — whatever answers this origin is standing in', 'warn');
    waitForService();
} else {
    tizen.application.launchAppControl(
        new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
        `${application.appInfo.packageId}.TizenHomebrewService`,
        () => {
            say('the platform accepted the service launch', 'ok');
            waitForService();
        },
        (error) => {
            say(`could not launch the service: ${error.message}`, 'err');
            // It may already be running from an earlier launch, so still poll.
            waitForService();
        }
    );
}
