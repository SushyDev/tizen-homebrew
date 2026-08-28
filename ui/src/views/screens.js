// Every screen of the phone UI, as a function of state.
//
// Each export takes the whole state and returns markup. None touches the DOM
// or knows when it will run, which is what makes them readable in isolation
// and renderable side by side in the preview harness.
//
// The layout rule throughout: prose in the UI face, and anything the machine
// produced — an id, a version, a size, a path, a port — in monospace. That
// split is the identity, and it also happens to tell a reader instantly which
// half of the screen is a fact and which is an explanation.
//
// Class names here are the vocabulary defined in app.css and nothing else.
// There are no utility classes to compose, because the television's engine
// silently drops half of what a utility framework emits — and the phone page
// and the TV page are the same stylesheet.
//
// `data-focus` is on everything a person can reach. On this page it is only
// used when a keyboard is driving; on the television it is what the direction
// keys search. Marking it in both places costs an attribute and means the
// phone UI is navigable from a remote if anyone ever points one at it.

import { html } from '../core/view.js';
import { wordmark } from './television.js';

// ── The bar ───────────────────────────────────────────────────────────

// The same wordmark the television carries, at the size a phone can hold.
// Beside it, the two things about this page rather than about the TV: whether
// the socket is up, and whether the channel theme is playing.
const masthead = (state) => html`
  <div class="bar">
    ${wordmark()}
    <span class="inline">
      <span class="micro mono">${state.connection}</span>
      <button class="btn btn-quiet" data-focus="theme" data-on-click="theme"
              aria-pressed="${state.themeOn}"
              title="The Homebrew Channel theme">${state.themeOn ? 'theme · on' : 'theme · off'}</button>
    </span>
  </div>`;

// ── Pairing ───────────────────────────────────────────────────────────

// The only thing on screen until it is done — nothing else here works without
// it, so offering anything else would just be something to fail at.
//
// The field is dressed as the other half of the code shown on the TV: same
// recess, same edge, same aqua. You are copying something across a room, and
// the two ends should look like the same object.
const pairing = (state) => html`
  <div class="glass pad stack stack-wide">
    <div class="stack stack-tight">
      <span class="label">Pairing required</span>
      <p class="small">Enter the six digits shown on the TV. They change each time the
        channel restarts.</p>
    </div>

    <input class="field code-field mono" id="pin" type="tel" inputmode="numeric" maxlength="6"
           autocomplete="off" placeholder="······" data-focus="pin" data-on-input="pin">

    ${state.pinError
        ? html`<div class="state state-fault">
             <span class="state-head">Rejected</span>
             <span class="small">${state.pinError}</span>
           </div>`
        : ''}
  </div>`;

// ── State ─────────────────────────────────────────────────────────────

// Readiness reads before any word does, from the band alone.
const status = (state) => {
    const { device } = state;

    const band = (tone, head, body) => html`
      <div class="state state-${tone}">
        <span class="state-head">${head}</span>
        <span class="small">${body}</span>
      </div>`;

    if (!device) return band('warn', 'Checking', 'Asking the TV about itself.');

    if (!device.onTv) return band('warn', 'Off device', 'Running as a development harness. Installs need real hardware.');

    if (device.ready) {
        return band('ok', 'Ready', html`This TV installs its own apps${
            device.platformVersion ? html` · <span class="mono">Tizen ${device.platformVersion}</span>` : ''}.`);
    }

    if (device.reason === 'debugModeOff') {
        return band('warn', 'Developer mode off',
            html`Turn it on in Apps › 12345 › Settings, then restart the TV.`);
    }

    // The current developer IP is deliberately not quoted. The device API has
    // been caught reporting 127.0.0.1 while sdbd accepted only another machine
    // — printing it states something that may simply be false.
    return band('warn', 'No sdb route',
        html`Set <span class="mono ink">Host PC IP</span> to <span class="mono ink">127.0.0.1</span>
             in Apps › 12345 › Settings, then restart the TV — that value is only read at startup.`);
};

// ── Tabs ──────────────────────────────────────────────────────────────

const TABS = [
    ['catalog', 'apps'],
    ['upload', 'upload'],
    ['github', 'github'],
    ['url', 'url'],
    ['usb', 'usb'],
    ['relay', 'shell']
];

const tabs = (state) => html`
  <div class="tabs" role="tablist">
    ${TABS.map(([id, label]) => html`
      <button class="tab" role="tab" aria-selected="${state.tab === id}"
              data-focus="tab:${id}" data-on-click="tab:${id}">${label}</button>`)}
  </div>`;

// ── Panels ────────────────────────────────────────────────────────────

const section = (label, body, footer = '') => html`
  <div class="glass pad stack stack-snug">
    <span class="label">${label}</span>
    ${body}
    ${footer}
  </div>`;

const catalog = (state) => section('Available', state.catalog.length === 0
    ? html`<p class="small">Nothing listed yet. Use upload, github or url.</p>`
    : html`<div class="list">
        ${state.catalog.map((app) => html`
          <div class="row split">
            <div class="stack stack-tight">
              <span class="inline">
                <span class="name truncate">${app.name}</span>
                <span class="mono micro">${app.version || ''}</span>
              </span>
              <span class="small truncate">${app.description || app.source.ref}</span>
            </div>
            <button class="btn btn-ghost" data-focus="app:${app.id}"
                    data-on-click="install:catalog:${app.id}">install</button>
          </div>`)}
      </div>`,
    html`<button class="btn btn-ghost btn-start" data-focus="refresh"
                 data-on-click="catalog:refresh">refresh</button>`);

const upload = (state) => section('Upload a package', html`
    <p class="small">Send a .wgt straight from this device. Nothing needs hosting.</p>

    <label for="file" class="drop">
      <span class="mono ${state.file ? 'ink' : 'small'}">${state.file ? state.file.name : 'choose a file'}</span>
      <span class="micro mono">${state.file ? `${Math.round(state.file.size / 1024)} KB` : 'or drag one here'}</span>
    </label>
    <input id="file" type="file" accept=".wgt,.tpk" hidden data-on-change="file">

    ${state.uploading !== null ? html`<div class="meter"><i style="width:${state.uploading}%"></i></div>` : ''}`,
    state.file
        ? html`<button class="btn btn-signal btn-wide" data-focus="upload" data-on-click="upload"
                       ${state.uploading !== null ? 'disabled' : ''}>install</button>`
        : '');

const remoteSource = ({ label, id, placeholder, action, hint, value }) => section(label, html`
    <div class="entry">
      <input class="field" id="${id}" placeholder="${placeholder}" value="${value || ''}"
             data-focus="${id}" data-on-enter="${action}"
             autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="btn" data-focus="${id}:go" data-on-click="${action}">install</button>
    </div>
    <p class="small">${hint}</p>`);

const fromGitHub = (state) => remoteSource({
    label: 'GitHub release', id: 'gh', placeholder: 'owner/repo', action: 'install:github',
    hint: 'The newest release’s .wgt asset. Public repositories only.', value: state.github
});

const fromUrl = (state) => remoteSource({
    label: 'Direct URL', id: 'url', placeholder: 'https://…/App.wgt', action: 'install:url',
    hint: 'Must be https.', value: state.url
});

const usb = (state) => section('Attached storage', html`
    <span class="mono small truncate">${state.usbPath}</span>
    <div class="list">
      ${state.usb.map((entry) => html`
        <button class="row row-button inline" data-focus="path:${entry.path}"
                data-on-click="usb:${entry.path}">
          <span class="mono micro">${entry.isDirectory ? '/' : '·'}</span>
          <span class="mono truncate ${entry.isDirectory ? 'small' : 'ink'}">${entry.name}</span>
        </button>`)}
    </div>`);

const relay = (state) => section('Command relay', html`
    <p class="small">Developer Mode is pinned to loopback, so no other machine can reach this
      TV’s sdb daemon. The channel runs on the TV, so it can — and can relay for you.</p>

    <div class="state state-warn">
      <span class="state-head">Arbitrary commands</span>
      <span class="small">Leave this off unless you are using it.</span>
    </div>

    <label class="toggle">
      <input type="checkbox" data-focus="relay" ${state.relayEnabled ? 'checked' : ''}
             data-on-change="relay:toggle">
      <span class="small">Enable the relay</span>
    </label>

    ${state.relayEnabled ? html`
      <div class="entry">
        <input class="field" id="cmd" placeholder="pkgcmd -l" data-focus="cmd"
               data-on-enter="relay:run" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="btn" data-focus="cmd:go" data-on-click="relay:run"
                ${state.relayBusy ? 'disabled' : ''}>run</button>
      </div>
      <pre class="log shell">${state.relayOutput || ' '}</pre>` : ''}`);

const PANELS = { catalog, upload, github: fromGitHub, url: fromUrl, usb, relay };

const panel = (state) => PANELS[state.tab](state);

// ── Outcome ───────────────────────────────────────────────────────────

const PHASES = ['probing', 'fetching', 'resigning', 'staging', 'installing'];

const PHASE_WORDS = {
    probing: 'Checking the TV',
    fetching: 'Downloading',
    resigning: 'Re-signing',
    staging: 'Copying to the TV',
    installing: 'Installing'
};

const outcome = (state) => {
    if (state.phase) {
        const step = PHASES.indexOf(state.phase) + 1;

        return html`
          <div class="glass pad stack stack-snug">
            <div class="split split-baseline">
              <span class="value truncate">${PHASE_WORDS[state.phase] || state.phase}</span>
              <span class="mono micro">${step}/${PHASES.length}${state.phaseDetail ? ` · ${state.phaseDetail}` : ''}</span>
            </div>
            <div class="meter"><i style="width:${Math.round((step / PHASES.length) * 100)}%"></i></div>
          </div>`;
    }

    if (state.error) {
        // Three lines, in the order somebody actually needs them: what went
        // wrong, what the television itself said, and what to do about it.
        // The last is absent for failures nothing has a cure for, and that is
        // better than a sentence invented to fill the space.
        return html`
          <div class="state state-fault">
            <span class="state-head">Failed</span>
            <span class="small ink">${state.error.title}</span>
            <span class="mono micro wrap">${state.error.detail}</span>
            ${state.error.remedy ? html`<span class="small wrap">${state.error.remedy}</span>` : html``}
          </div>`;
    }

    if (state.done) {
        return html`
          <div class="state state-ok">
            <span class="state-head">Installed</span>
            <span class="small ink">${state.done.name || state.done.packageId}</span>
            <span class="mono micro wrap">${state.done.packageId}${state.done.version ? ` · ${state.done.version}` : ''} · on the TV’s home row</span>
          </div>`;
    }

    return html``;
};

export { masthead, pairing, status, tabs, panel, outcome };
