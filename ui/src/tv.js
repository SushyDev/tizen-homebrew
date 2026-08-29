import './app.css';

import { createStore } from './core/store.js';
import { mount, delegate } from './core/view.js';
import { remote, KEY } from './core/remote.js';
import { sea } from './scene/sea.js';
import { theme } from './scene/theme.js';
import { masthead, connect, status, log, overlay, deck, windowOf } from './views/television.js';

const PORT = 8091;

// Off a television there is no `tizen` object, which is what makes this page openable in a browser.
const platform = typeof tizen === 'undefined' ? null : tizen;
const application = platform ? platform.application.getCurrentApplication() : null;

const BASE = application ? `http://127.0.0.1:${PORT}` : '';

const RED = 403;

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

const MAX_LINES = 1000;

let clockOffset = null;

const stamp = () => (clockOffset === null
    ? { t: Date.now() - started, estimated: true }
    : { t: Date.now() - started + clockOffset, estimated: false });

const restamp = (lines) => lines.map((line) => (line.estimated
    ? { ...line, t: line.t + clockOffset, estimated: false }
    : line));

let arrivals = 0;

// Both the service and this page write here, so lines are sorted by time with arrival order as a stable
// tie-break.
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

const say = (text, level = 'info') => append([{ ...stamp(), facility: 'ui', level, text }]);

window.onerror = (message, _source, line) => say(`page error: ${message} (line ${line})`, 'err');

const water = sea({ pointer: false });

const channel = theme({
    onState: ({ playing }) => store.update({ themeOn: playing })
});

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

const leave = () => {
    if (application) return application.exit();
    say('exit: not running on a television', 'warn');
};

const open = (view) => store.update((state) => {
    const { rows, total } = windowOf({ ...state, view });

    return { view, rows: null, from: view === 'logs' ? Math.max(0, total - rows) : 0 };
});

const close = () => {
    const { view } = store.get();

    store.update({ view: 'main', from: 0, rows: null });

    keys.focus(view === 'credits' ? 'credits' : 'logs');
};

const scroll = (steps, page) => store.update((state) => {
    const { rows, total } = windowOf(state);
    if (!rows) return {};

    const ceiling = Math.max(0, total - rows);
    const next = state.from + steps * (page ? rows : 1);

    return { from: Math.max(0, Math.min(ceiling, next)) };
});

const toEnd = () => store.update((state) => {
    const { rows, total } = windowOf(state);

    return rows ? { from: Math.max(0, total - rows) } : {};
});

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
    onBack: () => (store.get().view === 'main' ? leave() : close()),

    onKey: (keyCode) => {
        const { view } = store.get();

        if (keyCode === RED) {
            if (view === 'main') water.popAll(); else toEnd();
            return true;
        }

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

mount(store, { masthead, connect, status, log, overlay, deck });

// Measuring the pane changes what there is to measure, so a repeated count ends the pass at the
// smallest one — a cycle here recursed until the app died.
let offered = [];
let settling = false;

const fit = () => {
    const pane = document.querySelector('.curtain .feed, .curtain .roll');
    if (!pane) return;

    const edges = pane.getBoundingClientRect();

    const upward = getComputedStyle(pane).alignContent.indexOf('end') !== -1;

    const rows = Array.prototype.slice.call(pane.querySelectorAll('[data-row]'))
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

const remeasure = () => {
    offered = [];
    fit();
};

// The deck is replaced wholesale on every repaint, so focus is put back by name.
store.subscribe(() => {
    keys.restore();

    if (settling) fit(); else remeasure();
});

keys.focus('theme');

window.addEventListener('resize', remeasure);

const LOG_INTERVAL = 1000;

let sinceSeq = 0;
let lastUptime = 0;
let logAnswered = false;
let logMisses = 0;

const watchLog = async () => {
    try {
        const { lines, uptime } = await ask(`/logs?since=${sinceSeq}`);

        // A clock that went backwards means the service restarted, so its sequence starts again from one.
        if (uptime + 1000 < lastUptime) {
            sinceSeq = 0;
            lastUptime = 0;
            clockOffset = null;
            say('the service restarted — reading its log from the beginning', 'warn');
            return;
        }

        lastUptime = uptime;

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
        if (!logAnswered) return;

        logMisses += 1;
        if (logMisses === 3) say(`the service stopped answering its log (${failure.message})`, 'err');
    }
};

const watchReadiness = async () => {
    try {
        const state = await ask('/state');
        store.update({ ready: state.sdbReachable });
    } catch (e) {
        // The log already says the service is unreachable.
    }

    // Re-read every poll: the PIN is regenerated on every service start, so a restart leaves a dead code on
    // screen.
    try {
        const { pin } = await ask('/pin');

        if (pin && pin !== store.get().pin) {
            store.update({ pin });
            say('the service restarted — this is its new pairing code', 'warn');
        }
    } catch (e) {
        // The readiness poll reports a service that has gone away.
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

        if (attempts === 60) {
            say(`nothing on port ${PORT} after 30s — the platform can be slow to start it`, 'warn');
            say('still asking, every three seconds', 'warn');
        }

        // Slowing down, never stopping: one set took twenty-four seconds to launch its own service.
        setTimeout(waitForService, attempts < 60 ? 500 : 3000);
    }
};

watchLog();
setInterval(watchLog, LOG_INTERVAL);

say('asking the platform to start the background service');

if (!application) {
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
