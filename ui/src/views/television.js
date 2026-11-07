// Anything focusable carries `data-focus`: it is what core/remote.js searches and restores focus by.

import { html, raw, escape } from '../core/view.js';
import { encode } from '../core/qr.js';
import { major } from '../core/launch.js';
import { CREDITS } from './credits.js';

const DISCORD = 'https://discord.gg/WjxVnrsV4A';

// How long the service may stay silent before the band stops saying "starting".
const SLOW = 20000;
const STUCK = 75000;

// Neither overlay scrolls, so each shows a window of rows. These are first-paint guesses; tv.js measures the
// real count.
const ROWS = { logs: 14, credits: 10 };

// Rows drawn past the fold, so the pane fills to its bottom edge and tv.js always has a row below the last
// readable one.
const SPARE = 3;

const BAND = 12;

const wordmark = (extra = '') => html`
  <span class="mark ${extra}">
    <b>tizen <i>homebrew</i></b>
  </span>`;

const VERSION = __HOMEBREW_VERSION__;

// A service build from another version means the update installed but the old service is still running.
const stale = (build) => Boolean(build) && build.indexOf(`${VERSION}+`) !== 0;

const masthead = (state) => html`
  <div class="bar">
    ${wordmark('mark-hero')}
    <span class="version">
      <span class="version-number mono">v${VERSION}</span>
      ${stale(state.build) ? html`<span class="micro mono tone-warn">service ${state.build}</span>` : ''}
    </span>
  </div>`;

const code = (pin) => html`
  <span class="code">
    ${(pin || '······').split('').map((character) => html`
      <span class="digit ${pin ? '' : 'digit-blank'}">${character}</span>`)}
  </span>`;

// SVG rather than canvas, so it is plain markup like everything else on the page.
const qr = (text, label) => {
    let rows;

    try {
        rows = encode(text, 'M');
    } catch (e) {
        return html``;
    }

    const quiet = 4;
    const size = rows.length + quiet * 2;
    const path = rows.map((row, y) => row.map((dark, x) => (dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : '')).join('')).join('');

    return raw(`<svg class="qr" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${escape(label)}">` +
        `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`);
};

const reachable = (url) => typeof url === 'string' && url.indexOf('http') === 0;

const connect = (state) => html`
  <div class="glass marquee">
    <div class="stack stack-snug">
      <span class="label">Open on your phone</span>
      <span class="readout">${state.url || '—'}</span>
    </div>
    <div class="stack stack-snug">
      <span class="label">Pairing code</span>
      ${code(state.pin)}
    </div>
    ${reachable(state.url) ? html`<div class="marquee-qr">${qr(state.url, 'Scan to open on your phone')}</div>` : ''}
  </div>`;

const band = (tone, head, body) => html`
  <div class="state state-${tone}">
    <span class="state-head">${head}</span>
    <span class="small">${body}</span>
  </div>`;

const steps = (items) => html`<ol class="steps">${items.map((item) => html`<li>${item}</li>`)}</ol>`;

const RESTART_FULLY = html`Restart the TV fully: hold the power button on the remote until the Samsung logo shows. Standby is not enough.`;

const silence = (state) => {
    const waited = state.now - state.started;
    const old = major(state.tizen) > 0 && major(state.tizen) < 6;

    if (waited < SLOW && !state.launchError) {
        return band('calm', 'Starting', 'Starting the background service. This takes a few seconds, longer right after the TV turns on.');
    }

    if (old) {
        return band('fault', `Tizen ${state.tizen} may be too old`, html`The service has not answered in ${Math.round(waited / 1000)}s.
            Many Tizen 5 TVs ship a service runtime older than Homebrew needs, and nothing set on the TV changes that.
            ${steps([RESTART_FULLY, html`Still the same? Press <b>help</b> and send a report, so we know which TVs are affected.`])}`);
    }

    if (waited < STUCK && !state.launchError) {
        return band('warn', 'Still starting', 'Right after the TV turns on this can take up to a minute. Leave this screen open.');
    }

    return band('fault', 'The background service is not running', html`
        ${state.launchError ? html`The TV said: <span class="mono ink">${state.launchError}</span>` : html`It has not answered in ${Math.round(waited / 1000)}s.`}
        ${steps([
            RESTART_FULLY,
            'Open Tizen Homebrew again and give it a minute.',
            html`Still stuck? Press <b>help</b>: it shows everything the maintainer needs in one photo.`
        ])}`);
};

const status = (state) => {
    if (state.fatal) {
        return band('fault', 'The service crashed while starting', html`<span class="mono ink">${state.fatal}</span>
            ${steps([RESTART_FULLY, html`If it comes back, press <b>help</b> and send a report.`])}`);
    }

    if (!state.connected) return silence(state);

    if (state.ready === null) return band('calm', 'Checking', 'The service is running and checking whether this TV can install apps.');

    // Working is the ordinary state, and the log grows into the room a band saying so would hold.
    if (state.ready) return html``;

    return band('warn', 'Phones can pair, but installing will not work yet', html`Set <span class="mono ink">Host PC IP</span> to
        <span class="mono ink">127.0.0.1</span> in Apps › 12345 › Settings, then restart the
        TV — that value is only read at startup.`);
};

const SPACES = '            ';

const stamp = (t) => {
    const seconds = ((Number(t) || 0) / 1000).toFixed(3);
    return `[${SPACES.slice(0, Math.max(0, 9 - seconds.length))}${seconds}]`;
};

// Three cells straight into one grid, so every line shares the column tracks. `data-row` marks the first cell
// for tv.js.
const line = (entry) => html`
  <span class="mono stamp" data-row>${stamp(entry.t)}</span>
  <span class="mono facility">${entry.facility || 'svc'}:</span>
  <span class="tone-${entry.level || 'info'}">${entry.text}</span>`;

// People read any yellow line as a failure, so the caption says whether anything is actually wrong.
const caption = (state) => {
    if (state.connected && state.ready) return 'all good · this log is only for troubleshooting';
    if (!state.connected && state.now - state.started < SLOW && !state.launchError) return 'lines while starting are normal';

    return tally(state.lines);
};

const log = (state) => html`
  <div class="feed-head">
    <span class="label">Activity</span>
    <span class="small">${caption(state)}</span>
  </div>
  <div class="feed log">
    ${state.lines.slice(-BAND).map(line)}
  </div>`;

const legend = (keys) => html`
  <div class="legend">
    ${keys.map(([key, meaning]) => html`
      <span class="legend-key"><span class="key">${key}</span><span>${meaning}</span></span>`)}
  </div>`;

const windowOf = (state) => ({
    rows: state.rows || ROWS[state.view] || 0,
    total: state.view === 'credits' ? CREDITS.length : state.lines.length
});

// Clamped here too, because the list moves under the window as well as the window over the list.
const framed = (state, all, anchor) => {
    const { rows } = windowOf(state);
    const from = Math.max(0, Math.min(state.from, all.length - rows));

    // A log hangs off its newest line and is clipped at the top; a document starts at its first and is clipped
    // at the bottom.
    const ends = anchor === 'end';

    return {
        from,
        fits: Math.min(rows, all.length - from),
        shown: all.slice(ends ? Math.max(0, from - SPARE) : from, ends ? from + rows : from + rows + SPARE)
    };
};

const position = (from, fits, total, noun) => html`
  <span class="micro mono">${total
      ? `${from + 1}–${from + fits} of ${total}`
      : `no ${noun} yet`}</span>`;

const head = (title, where) => html`
  <div class="bar bar-overlay">
    <span class="label">${title}</span>
    ${where}
    <button class="btn btn-quiet" data-focus="close" data-on-click="close">back</button>
  </div>`;

const KEYS = [['▲ ▼', 'a line'], ['◀ ▶', 'a page'], ['↩', 'back']];

const tally = (lines) => {
    const of = (level) => lines.filter((entry) => entry.level === level).length;
    const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

    const problems = [
        of('err') > 0 ? plural(of('err'), 'error') : null,
        of('warn') > 0 ? plural(of('warn'), 'warning') : null
    ].filter(Boolean);

    return problems.length ? problems.join(' · ') : 'nothing wrong';
};

const console_ = (state) => {
    const { from, fits, shown } = framed(state, state.lines, 'end');

    return html`
      <div class="curtain">
        <div class="glass console">
          ${head(html`Log <span class="small">· ${tally(state.lines)}</span>`,
              position(from, fits, state.lines.length, 'lines'))}
          <div class="feed log">${shown.map(line)}</div>
          ${legend(KEYS.concat([['RED', 'newest']]))}
        </div>
      </div>`;
};

// Every kind of row is one line high, which is what lets the window above count rows rather than measure them.
const credit = (row) => {
    if (row.head) return html`<div class="credit credit-rule" data-row><span class="label">${row.head}</span></div>`;
    if (row.note) return html`<div class="credit credit-note" data-row><span class="small">${row.note}</span></div>`;

    return html`
      <div class="credit" data-row>
        <span class="truncate">
          <span class="name">${row.name}</span>${row.by ? html` <span class="small">· ${row.by}</span>` : ''}
        </span>
        <span class="mono small">${row.at || ''}</span>
      </div>`;
};

const credits = (state) => {
    const { from, fits, shown } = framed(state, CREDITS, 'start');

    return html`
      <div class="curtain curtain-dim">
        <div class="glass dialog">
          ${head('Credits', position(from, fits, CREDITS.length, 'credits'))}
          <div class="roll">${shown.map(credit)}</div>
          ${legend(KEYS)}
        </div>
      </div>`;
};

const fact = (name, value) => html`<dt>${name}</dt><dd class="mono">${value || 'unknown'}</dd>`;

const serviceFact = (state) => {
    if (state.fatal) return `crashed: ${state.fatal}`;
    if (state.connected) return state.ready ? 'running, can install' : 'running, cannot install yet';
    return state.launchError ? `not running (${state.launchError})` : 'not running';
};

const reportArea = (state) => {
    if (!state.support) {
        return html`<p class="small">Take a photo of this whole screen and post it in the Discord: it has everything needed to start.</p>`;
    }

    const report = state.report || {};
    const label = { sending: 'sending…', done: 'send again', failed: 'try sending again' }[report.state] || 'send report to support';

    return html`
      <div class="stack stack-snug">
        <button class="btn" data-focus="send" data-on-click="send">${label}</button>
        ${report.state === 'done' ? html`<span class="small">Post this code in the Discord:</span><span class="report-code mono">${report.code}</span>` : ''}
        ${report.state === 'failed' ? html`<span class="small tone-err">${report.message}. A photo of this screen works too.</span>` : ''}
      </div>`;
};

const helpCode = (state) => {
    const report = state.report || {};

    if (report.state === 'done' && report.url) return [report.url, 'Your report'];
    if (state.connected && reachable(state.url)) return [`${state.url}/diag`, 'Diagnostics on your phone'];

    return [DISCORD, 'Discord'];
};

const help = (state) => {
    const [target, label] = helpCode(state);

    return html`
      <div class="curtain curtain-dim">
        <div class="glass dialog help">
          ${head('Get help', html`<span class="micro mono">v${VERSION}</span>`)}
          <div class="help-body">
            <div class="stack">
              <dl class="facts">
                ${fact('Homebrew', `v${VERSION}`)}
                ${fact('Tizen', state.tizen)}
                ${fact('Model', state.model)}
                ${fact('Service', serviceFact(state))}
                ${fact('Address', state.url)}
              </dl>
              ${reportArea(state)}
            </div>
            <div class="help-qr">
              ${qr(target, label)}
              <span class="label">${label}</span>
              <span class="micro mono">${target}</span>
            </div>
          </div>
          ${legend([['◀ ▶', 'choose'], ['OK', 'select'], ['↩', 'back']])}
        </div>
      </div>`;
};

const overlay = (state) => {
    if (state.view === 'logs') return console_(state);
    if (state.view === 'credits') return credits(state);
    if (state.view === 'help') return help(state);

    return html``;
};

const deck = (state) => {
    // Said again here, since a dropped CSS rule would otherwise strand focus on buttons nobody can see.
    if (state.view !== 'main') return html``;

    const button = (name, label) => html`
      <button class="btn" data-focus="${name}" data-on-click="${name}">${label}</button>`;

    return html`
      <div class="stack stack-snug">
        <div class="deck">
          ${button('help', 'help')}
          ${button('restart', state.restarting ? 'restarting…' : 'restart service')}
          ${button('logs', 'show logs')}
          ${button('theme', state.themeOn ? 'theme · on' : 'theme · off')}
          ${button('pop', 'pop bubbles')}
          ${button('credits', 'credits')}
          ${button('exit', 'exit')}
        </div>

        ${legend([
            ['◀ ▶', 'choose'],
            ['OK', 'select'],
            ['RED', 'pop bubbles'],
            ['↩', 'exit']
        ])}
      </div>`;
};

export { masthead, connect, status, log, overlay, deck, windowOf, wordmark, code, band, ROWS, SPARE };
