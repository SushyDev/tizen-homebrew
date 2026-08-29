// Anything focusable carries `data-focus`: it is what core/remote.js searches and restores focus by.

import { html } from '../core/view.js';
import { CREDITS } from './credits.js';

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

const masthead = (state) => html`
  <div class="bar">
    ${wordmark('mark-hero')}
    <span class="micro mono">${state.build ? `build ${state.build}` : ''}</span>
  </div>`;

const code = (pin) => html`
  <span class="code">
    ${(pin || '······').split('').map((character) => html`
      <span class="digit ${pin ? '' : 'digit-blank'}">${character}</span>`)}
  </span>`;

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
  </div>`;

const band = (tone, head, body) => html`
  <div class="state state-${tone}">
    <span class="state-head">${head}</span>
    <span class="small">${body}</span>
  </div>`;

const status = (state) => {
    if (state.ready === null) return band('warn', 'Starting', 'Waiting for the background service.');

    if (state.ready) return band('ok', 'Ready', 'This TV can install its own apps.');

    return band('warn', 'No sdb route', html`Set <span class="mono ink">Host PC IP</span> to
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

const log = (state) => html`
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

const overlay = (state) => {
    if (state.view === 'logs') return console_(state);
    if (state.view === 'credits') return credits(state);

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
