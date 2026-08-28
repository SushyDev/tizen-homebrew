import './app.css';

import { createStore } from './core/store.js';
import { readPackage } from './core/package.js';
import { connect, upload } from './core/socket.js';
import { remembered, remember, forget, DIGITS } from './core/pairing.js';
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
//
// Titles only, and deliberately: these are the strings that would be
// translated, so they say what happened and never what to do about it. What to
// do arrives with the failure as `remedy`, from service/src/install/verdicts.js
// — it names the package to remove or the command to run, and neither can be
// known here. The codes come from protocol.js; every one of them belongs in
// this table, because a code with no entry renders as a bare "Failed."
const EXPLANATIONS = {
    unauthorized: 'Enter the PIN shown on the TV first.',
    lockedOut: 'Too many incorrect PINs.',
    debugModeOff: 'Developer Mode is off on this TV.',
    sdbUnreachable: 'This TV cannot reach its own sdb daemon.',
    sdbRefused: 'This TV refused the connection to its own sdb daemon.',
    sdbTimeout: 'The TV stopped answering partway through.',
    debugIpWrong: 'The TV’s developer host IP is not 127.0.0.1.',
    notFound: 'Not found.',
    downloadFailed: 'The download failed.',
    badPackage: 'That file is not a valid Tizen package.',
    certsMissing: 'This TV needs a Samsung certificate first.',
    resignFailed: 'Re-signing failed.',
    badMessage: 'That request was refused.',
    relayDisabled: 'The command relay is off.',
    internal: 'Something went wrong.',

    // What a television says about a package it will not install.
    installFailed: 'The TV rejected the install.',
    certRejected: 'The TV rejected the certificate; it has been cleared.',
    authorMismatch: 'A different build of this app is already installed.',
    certChainInvalid: 'That package is signed for a device this is not.',
    securityError: 'The TV refused the package before reading it.',
    privilegeTooHigh: 'That app asks for more than this TV will grant.'
};

// The last PIN that paired this phone with this TV, if there is one. It is
// offered on connect rather than asked for again — see core/pairing.js for
// what is kept, and for when it is dropped.
const known = remembered();

const store = createStore({
    connection: 'connecting…',
    paired: false,
    pin: known,
    pinError: null,

    // The PIN this phone is waiting on an answer for, and whether it came from
    // memory rather than from somebody typing it. The first tells a refusal
    // apart from the greeting — see the hello reaction, where the service
    // sends the same frame for both. The second decides how that refusal is
    // worded, and that the field is not shown for the moment a restore takes.
    pending: '',
    restoring: known.length === DIGITS,

    device: null,
    catalog: [],
    catalogStale: false,

    tab: 'catalog',
    github: '',
    url: '',
    usb: [],
    usbPath: '/media',

    file: null,
    reading: false,
    uploading: null,

    // What the package about to be installed — or just installed — says it
    // is: name, version, id and icon. It arrives from the service for every
    // source it can open, and from core/package.js for an upload, which is
    // the one the phone is holding. Null until something has been read.
    identity: null,

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
    // A connection that is not up cannot be pairing. Without the second half
    // of this, a phone that cannot reach its TV sits on "offering the code"
    // with no field to type a different one into.
    onStatus: (connection) => store.update(
        connection === 'connected' ? { connection } : { connection, pending: '', restoring: false }
    ),

    onMessage: (type, payload) => {
        // One place where every inbound message is turned into new state. A
        // handler that returns nothing leaves the state alone.
        const reactions = {
            hello: () => {
                const { pin, pending, restoring } = store.get();

                if (payload.ok) {
                    // Kept only once it has actually worked, so the code this
                    // phone offers next time is never one that never did.
                    remember(pin);
                    return { paired: true, pending: '', restoring: false, pinError: null };
                }

                // The service greets every connection with the same needsPin
                // frame it refuses with, so the two are told apart by whether
                // this phone is waiting on an answer. Nothing is pending, so
                // this is the greeting — and the greeting is the moment to
                // offer the code this phone already has rather than ask for
                // it again. Offering it any earlier, on the socket opening,
                // would make the greeting itself look like the refusal.
                //
                // A reconnection lands here too: the service knows nothing
                // about a client that dropped, so pairing has to be redone,
                // and until this it was not — the page stayed looking paired
                // while everything it tried came back unauthorized.
                if (!pending) {
                    if (pin.length !== DIGITS) return null;

                    send(Send.hello, { pin });
                    return { pending: pin, restoring: pin === remembered() };
                }

                // A refusal, then. Wrong, or merely old — the service mints a
                // new code every start, so a remembered one stops matching the
                // moment the TV restarts. Either way it is dropped rather than
                // retried: the socket reconnects every second and a half, and
                // retrying would spend all five attempts before anybody had
                // finished looking up at the screen.
                forget();

                return {
                    paired: false,
                    pending: '',
                    pin: '',
                    restoring: false,
                    pinError: restoring
                        ? 'The TV has restarted, so its PIN has changed.'
                        : 'That PIN did not match.'
                };
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

            progress: () => ({
                phase: payload.phase,
                phaseDetail: payload.detail,
                // Sent once, with the staging phase — the first moment the
                // service knows what it is holding. Every other progress
                // message leaves what was found in place.
                identity: payload.identity || store.get().identity,
                error: null,
                done: null
            }),

            done: () => ({ phase: null, phaseDetail: null, done: payload, error: null }),

            error: () => {
                // Before pairing, the PIN field is the only thing on screen —
                // the outcome panel that shows failures is not rendered yet.
                // So a refusal that arrives now is said there or nowhere, and
                // one does arrive here: a lockout, which the service reports
                // as an error rather than a refused hello. The PIN is left
                // alone, because being locked out says nothing about whether
                // it was the right one.
                if (!store.get().paired) {
                    return {
                        pending: '',
                        restoring: false,
                        pinError: payload.message || EXPLANATIONS[payload.code] || 'Refused.'
                    };
                }

                return {
                    phase: null,
                    relayBusy: false,
                    uploading: null,
                    error: {
                        title: EXPLANATIONS[payload.code] || 'Failed.',
                        detail: payload.message || '',
                        remedy: payload.remedy || null
                    }
                };
            }
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
    // The identity goes with it: whatever is on screen belongs to the last
    // install, and leaving it there would put one app's icon above another
    // app's progress bar for the four seconds before the service answers.
    store.update({ error: null, done: null, phase: 'probing', identity: null });
    send(Send.install, { source, ref: reference });
};

/**
 * Takes a file the person picked, and opens it.
 *
 * Reading the archive is what turns `download (2).wgt` back into the
 * application inside it, and it happens now rather than after the upload
 * because the whole value of it is being able to see what this is *before*
 * spending a minute of wifi on it. It is allowed to come back with nothing —
 * see core/package.js — in which case the filename stands as it always did.
 */
const chooseFile = async (file) => {
    store.update({ file, identity: null, reading: Boolean(file), error: null, done: null });

    if (!file) return;

    const app = await readPackage(file);

    // Somebody may have chosen a different file while this one was being
    // read. Whichever is in the well now is the one the card describes.
    if (store.get().file !== file) return;

    store.update({ identity: app, reading: false });
};

delegate({
    // The PIN submits itself on the sixth digit: asking someone to press a
    // button after typing exactly six digits is a step that earns nothing.
    pin: (element) => {
        const digits = element.value.replace(/\D/g, '').slice(0, DIGITS);
        element.value = digits;
        const complete = digits.length === DIGITS;

        // Typed, so `restoring` is false and a refusal reads as a mistyped
        // code rather than as a television that has restarted.
        store.update({ pin: digits, pinError: null, restoring: false, pending: complete ? digits : '' });

        if (complete) send(Send.hello, { pin: digits });
    },

    'catalog:refresh': () => send(Send.catalog, { refresh: true }),

    'install:github': () => value('gh') && beginInstall('github', value('gh')),
    'install:url': () => value('url') && beginInstall('url', value('url')),

    file: (element) => chooseFile(element.files[0] || null),

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
                error: {
                    title: EXPLANATIONS[failure.code] || 'Install failed.',
                    detail: failure.message,
                    remedy: failure.remedy || null
                }
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
        store.update({ tab: 'upload' });
        chooseFile(event.dataTransfer.files[0]);
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
