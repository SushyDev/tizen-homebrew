import './app.css';

import { createStore } from './core/store.js';
import { connect, upload } from './core/socket.js';
import { mount, delegate } from './core/view.js';
import { sea } from './scene/sea.js';
import { theme } from './scene/theme.js';
import { masthead, pairing, status, tabs, panel, outcome } from './views/screens.js';

// The phone half of Tizen Homebrew, assembled.
//
// Read top to bottom: what it remembers, what the TV says, what a tap does.
// The views are pure functions of the state below, so nothing in this file
// touches the DOM either — it only ever moves the state and lets the render
// follow.

// The message names the service speaks. Kept as one object so a typo is a
// missing key rather than a string that silently never matches.
const Send = {
    hello: 'hello',
    state: 'getState',
    catalog: 'getCatalog',
    install: 'install',
    listDir: 'listDir',
    setRelay: 'setRelay',
    relayExec: 'relayExec'
};

// What each error code means to someone holding a phone, rather than what it
// means to the service.
const EXPLANATIONS = {
    unauthorized: 'Enter the PIN shown on the TV first.',
    lockedOut: 'Too many incorrect PINs.',
    debugModeOff: 'Developer Mode is off on this TV.',
    sdbUnreachable: 'This TV cannot reach its own sdb daemon.',
    notFound: 'Not found.',
    downloadFailed: 'The download failed.',
    badPackage: 'That file is not a valid Tizen package.',
    certsMissing: 'This TV needs a Samsung certificate first.',
    resignFailed: 'Re-signing failed.',
    installFailed: 'The TV rejected the install.',
    certRejected: 'The TV rejected the certificate; it has been cleared.',
    badMessage: 'That request was refused.',
    relayDisabled: 'The command relay is off.',
    internal: 'Something went wrong.'
};

const store = createStore({
    connection: 'connecting…',
    paired: false,
    pin: '',
    pinError: null,

    device: null,
    catalog: [],
    catalogStale: false,

    tab: 'catalog',
    github: '',
    url: '',
    usb: [],
    usbPath: '/media',

    file: null,
    uploading: null,

    relayEnabled: false,
    relayBusy: false,
    relayOutput: '',

    phase: null,
    phaseDetail: null,
    done: null,
    error: null,

    themeOn: false
});

// ── The scene ─────────────────────────────────────────────────────────

// The same ocean the television is showing, so the two ends of the pairing
// visibly belong to the same thing. A finger dragged across the page pops
// bubbles, which is what the Wii pointer did and is the only part of this
// interface that exists purely because it is nice. The handle it returns is
// for a page driven by a remote; here the finger does the popping.
sea();

// Off by default here, unlike the television. This page is very likely being
// held in the same room as a TV already playing the theme, and a second copy
// of it a few hundred milliseconds out of phase is the worst possible
// outcome. It stays off until asked, and then it is remembered.
const channel = theme({
    defaultOn: false,
    onState: ({ playing }) => store.update({ themeOn: playing })
});

// ── The connection ────────────────────────────────────────────────────

const { send } = connect({
    onStatus: (connection) => store.update({ connection }),

    onMessage: (type, payload) => {
        // One place where every inbound message is turned into new state. A
        // handler that returns nothing leaves the state alone.
        const reactions = {
            hello: () => {
                if (payload.ok) return { paired: true, pinError: null };
                // A rejected PIN is only worth reporting once one was offered;
                // the service greets every connection with needsPin.
                return store.get().pin.length === 6
                    ? { pinError: 'That PIN did not match.', pin: '' }
                    : null;
            },

            state: () => ({ device: payload }),

            catalog: () => ({ catalog: payload.entries || [], catalogStale: !!payload.stale }),

            dir: () => ({ usb: payload }),

            relayState: () => ({ relayEnabled: !!payload.enabled }),

            relayData: () => ({ relayOutput: store.get().relayOutput + payload.chunk }),

            relayEnd: () => ({
                relayBusy: false,
                relayOutput: `${store.get().relayOutput}${payload.truncated ? '\n[output truncated]' : ''}\n`
            }),

            progress: () => ({ phase: payload.phase, phaseDetail: payload.detail, error: null, done: null }),

            done: () => ({ phase: null, phaseDetail: null, done: payload, error: null }),

            error: () => ({
                phase: null,
                relayBusy: false,
                uploading: null,
                error: {
                    title: EXPLANATIONS[payload.code] || 'Failed.',
                    detail: payload.message || ''
                }
            })
        };

        const reaction = reactions[type];
        const changes = reaction && reaction();

        if (changes) store.update(changes);

        // Pairing succeeding is the cue to load everything that needs a PIN.
        if (type === 'hello' && payload.ok) {
            send(Send.catalog, {});
            send(Send.state, {});
        }
    }
});

// ── What a tap does ───────────────────────────────────────────────────

const value = (id) => {
    const element = document.getElementById(id);
    return element ? element.value.trim() : '';
};

const beginInstall = (source, reference) => {
    store.update({ error: null, done: null, phase: 'probing' });
    send(Send.install, { source, ref: reference });
};

delegate({
    // The PIN submits itself on the sixth digit: asking someone to press a
    // button after typing exactly six digits is a step that earns nothing.
    pin: (element) => {
        const digits = element.value.replace(/\D/g, '').slice(0, 6);
        element.value = digits;
        store.update({ pin: digits, pinError: null });

        if (digits.length === 6) send(Send.hello, { pin: digits });
    },

    'catalog:refresh': () => send(Send.catalog, { refresh: true }),

    'install:github': () => value('gh') && beginInstall('github', value('gh')),
    'install:url': () => value('url') && beginInstall('url', value('url')),

    file: (element) => store.update({ file: element.files[0] || null, error: null, done: null }),

    upload: async () => {
        const { file, pin } = store.get();
        if (!file) return;

        store.update({ uploading: 0, error: null, done: null });

        try {
            const result = await upload({
                file,
                pin,
                onProgress: (percent) => store.update({ uploading: percent })
            });

            store.update({ uploading: null, done: result, file: null });
        } catch (failure) {
            store.update({
                uploading: null,
                error: { title: EXPLANATIONS[failure.code] || 'Install failed.', detail: failure.message }
            });
        }
    },

    'relay:toggle': (element) => send(Send.setRelay, { enabled: element.checked }),

    tab: (_element, name) => {
        store.update({ tab: name });
        if (name === 'usb') send(Send.listDir, { path: store.get().usbPath });
    },

    // `install:github:owner/repo` — the source and its reference, in the name.
    install: (_element, argument) => {
        const separator = argument.indexOf(':');
        beginInstall(argument.slice(0, separator), argument.slice(separator + 1));
    },

    usb: (_element, path) => {
        const entry = store.get().usb.find((candidate) => candidate.path === path);
        if (!entry) return;

        if (!entry.isDirectory) return beginInstall('file', entry.path);

        store.update({ usbPath: entry.path });
        send(Send.listDir, { path: entry.path });
    },

    'relay:run': () => {
        const command = value('cmd');
        if (!command) return;

        store.update({ relayBusy: true, relayOutput: `${store.get().relayOutput}$ ${command}\n` });
        send(Send.relayExec, { id: String(Date.now()), command });

        document.getElementById('cmd').value = '';
    },

    theme: () => channel.toggle()
});

// Dropping a file anywhere is more forgiving than aiming at a target.
['dragover', 'drop'].forEach((name) => document.addEventListener(name, (event) => {
    event.preventDefault();
    if (name === 'drop' && event.dataTransfer.files.length) {
        store.update({ tab: 'upload', file: event.dataTransfer.files[0] });
    }
}));

// ── What is on screen ─────────────────────────────────────────────────

mount(store, {
    masthead,
    // Before pairing the only thing offered is the PIN; everything else would
    // just be something that cannot work yet.
    status: (state) => (state.paired ? status(state) : pairing(state)),
    tabs: (state) => (state.paired ? tabs(state) : { __markup: '' }),
    panel: (state) => (state.paired ? panel(state) : { __markup: '' }),
    outcome: (state) => (state.paired ? outcome(state) : { __markup: '' })
});
