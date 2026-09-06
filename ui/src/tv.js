import './app.css';

import { createStore } from './core/store.js';
import { mount, delegate } from './core/view.js';
import { remote, KEY } from './core/remote.js';
import { connect as openSocket } from './core/socket.js';
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
    view: 'main',
    from: 0,
    rows: null,
    themeOn: false,
    restarting: false
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

// The one thing left on HTTP: a single shot with no answer worth waiting for. Everything this page
// used to ask for repeatedly now arrives over the socket instead. The PIN comes from the service's
// own greeting, which it gives to loopback callers.
const post = (path) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', BASE + path, true);
    request.timeout = 4000;

    const { pin } = store.get();
    if (pin) request.setRequestHeader('x-homebrew-pin', pin);

    request.onload = () => (request.status < 400
        ? resolve(request.responseText)
        : reject(new Error(`HTTP ${request.status}`)));

    request.onerror = () => reject(new Error('unreachable'));
    request.ontimeout = () => reject(new Error('timeout'));
    request.send();
});

const SERVICE_ID = application ? `${application.appInfo.packageId}.TizenHomebrewService` : null;

const launchService = () => new Promise((resolve, reject) => {
    tizen.application.launchAppControl(
        new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
        SERVICE_ID,
        resolve,
        reject
    );
});

let leaving = false;

// Only this page leaves. The service is a separate application that starts with the television and is
// meant to outlive every visit to this screen — a phone can reach it with nobody in front of the set,
// which is the whole point of config.xml's on-boot. The audio is torn down here rather than left to
// the page going away, because a runtime that keeps the page alive keeps the theme playing over the
// Tizen home screen.
const leave = () => {
    if (leaving) return;

    if (!application) {
        say('exit: not running on a television', 'warn');
        return;
    }

    leaving = true;

    channel.stop();
    application.exit();
};

// Home cannot be intercepted: Back is a mandatory key the runtime delivers on its own, and the
// platform keeps Home for itself — registering it does nothing. What it does do is background the
// page, and a page that is only hidden goes on playing the theme over the Tizen home screen, which
// is the thing `background-support="disable"` exists to stop. So losing visibility ends the page
// the same way the exit button does.
//
// It has to happen here and now, in the handler. A hidden page has its timers frozen, so a delayed
// exit does not run while it is away — it runs on the way back, closing the app in the face of the
// person who just opened it.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) leave();
});

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
    restart: () => restart(),
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

keys.focus('restart');

window.addEventListener('resize', remeasure);

const Send = {
    hello: 'hello',
    watch: 'watch'
};

const Receive = {
    hello: 'hello',
    state: 'state',
    log: 'log'
};

let sinceSeq = 0;
let lastUptime = 0;

// Asking the platform to start the service is idempotent — a launch into one already running lands on
// its onRequest and does nothing — so it is safe to repeat while nothing answers, and repeating is what
// covers the case a socket cannot tell apart on its own: a service that is not slow but gone.
const relaunch = () => launchService().then(
    () => {},
    (error) => say(`could not launch the service: ${error.message}`, 'err')
);

// Twice the greeting: refused first, with the pairing code attached because this page is on loopback and
// GET /pin has always trusted that, then accepted once the code is handed back. Nothing is typed in here,
// and the code is kept across restarts, so a reboot does not strand the phone that paired.
const greeted = (payload) => {
    if (payload.ok) return link.send(Send.watch, { logsSince: sinceSeq });

    if (!payload.pin) {
        say('the service would not say what its pairing code is', 'err');
        return;
    }

    const shown = store.get().pin;
    if (shown && shown !== payload.pin) say('the pairing code changed — this is the new one', 'warn');

    const port = payload.port || PORT;
    const reachable = payload.addresses && payload.addresses.length;

    store.update({
        pin: payload.pin,
        url: reachable ? `http://${payload.addresses[0]}:${port}` : `port ${port}`,
        build: payload.build || null
    });

    link.send(Send.hello, { pin: payload.pin });
};

const logged = ({ lines, uptime }) => {
    // A clock that went backward means a different process, so its sequence starts again from one.
    if (uptime + 1000 < lastUptime) {
        sinceSeq = 0;
        lastUptime = 0;
        clockOffset = null;

        say('the service restarted — reading its log from the beginning', 'warn');

        link.send(Send.watch, { logsSince: 0 });
        return;
    }

    lastUptime = uptime;

    const first = clockOffset === null;
    clockOffset = uptime - (Date.now() - started);

    if (lines.length > 0) sinceSeq = lines[lines.length - 1].seq;

    append(lines.map((line) => ({
        t: line.t,
        facility: line.facility || 'svc',
        level: line.level || 'info',
        text: line.text
    })), first);
};

// Every fourth attempt, which with the socket's backoff is a few seconds apart at first and then every
// twelve. One launch would not be enough: a restart answers before it exits, so the launch that follows
// the drop can reach the process on its way out and be swallowed.
const RELAUNCH_EVERY = 4;

const changed = (status, attempt) => {
    if (status === 'connected') {
        say(`the service answered on port ${PORT}`, 'ok');
        store.update({ restarting: false });
        return;
    }

    // Nothing is known about the television until the service says so again.
    store.update({ ready: null });

    // attempt 0 is a socket that was open and dropped, which over loopback means the service exited.
    if (attempt === 0) say('the service went away', 'warn');
    if (attempt === 1) say('the service is not answering yet — waiting for it');
    if (attempt === 12) say('the service is slow to start', 'warn');
    if (attempt === 30) say('still waiting — the platform can be slow to start it', 'warn');

    if (application && attempt % RELAUNCH_EVERY === 0) relaunch();
};

const restart = () => {
    if (store.get().restarting) return;

    if (!application) {
        say('restart: not running on a television', 'warn');
        return;
    }

    store.update({ restarting: true });
    say('asking the service to restart', 'warn');

    // Nothing waits on the answer: the service replies before it exits, so what says it went is the
    // socket dropping, and `changed` above takes it from there — including clearing this flag once
    // something answers again. Only a refusal with a status behind it means nothing is restarting.
    post('/restart').catch((failure) => {
        if (failure.message.indexOf('HTTP') !== 0) return;

        say(`the service refused the restart (${failure.message})`, 'err');
        store.update({ restarting: false });
    });
};

// It is usually already up: config.xml starts it with the television. This is for the set that does
// not honour that, and it lands on a running service's onRequest otherwise.
if (application) {
    say('asking the platform to start the background service');
    relaunch();
} else {
    say('running off-TV — whatever answers this origin is standing in', 'warn');
}

// On the television the service is its own origin on loopback; off it, whatever is serving this page.
const link = openSocket({
    url: application ? `ws://127.0.0.1:${PORT}` : null,
    onStatus: changed,

    onMessage: (type, payload) => {
        if (type === Receive.hello) return greeted(payload);
        if (type === Receive.log) return logged(payload);
        if (type === Receive.state) return store.update({ ready: payload.sdbReachable });
    }
});
