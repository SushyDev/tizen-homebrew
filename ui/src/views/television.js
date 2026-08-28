// The television screen, as a function of state.
//
// It is read from three metres by someone holding a remote, which decides
// almost everything about it. It says three things and says them large —
// where to go on your phone, the code to type there, and whether this TV can
// install anything at all — and then gets out of the way.
//
// Below those is a log, which exists because debugging a service on a
// television is otherwise close to impossible: sdbd's command allowlist
// excludes every log tool and pulling files off the device is refused. It is
// the last band rather than the first because it is for the one evening in a
// year when something is wrong. What fits under the readouts is the tail of
// it; the rest is behind the `show logs` button, which hands the whole screen
// over to the console.
//
// That console and the credits are the two things here that are *read* rather
// than glanced at, and both are longer than a screen. Neither scrolls. See
// ROWS below for why.
//
// Anything a person can put focus on carries `data-focus`. That attribute is
// the whole contract with `core/remote.js`: it is what the direction keys
// search, and it is the name focus is restored by after a repaint.

import { html } from '../core/view.js';
import { CREDITS } from './credits.js';

// ── How much of a list is on screen ──────────────────────────────────────
//
// Neither overlay scrolls. TV webviews handle scrollTop inconsistently — the
// same reason the log band drops its oldest lines instead of scrolling — so
// each shows a window of rows and the remote moves the window through the
// list. What is on screen stays a pure function of state.
//
// How many rows that window holds is *measured*, though, and these are only
// the starting guesses used for the first paint. A fixed count is a guess
// about a pane whose height is a fraction of a screen this code has never
// seen, and guessing low leaves a band of empty glass under the last line —
// which is what a fixed count did. tv.js counts how many rows actually fit
// after each paint and puts the answer in the store; see `fit` there.
const ROWS = { logs: 14, credits: 10 };

// Rows rendered past the fold, so the pane is full to its bottom edge rather
// than ending in a gap, and so there is always something below the last
// readable row for the measurement to find. They are clipped by the feed's
// own overflow, and the header counts only the rows that fit.
const SPARE = 3;

// The tail of the log that fits under the readouts on the main screen. The
// buffer behind it is far longer — see tv.js.
const BAND = 12;

// ── The wordmark ─────────────────────────────────────────────────────────

// "the *tizen homebrew* channel", set the way the channel set its own name:
// the product carrying all the weight, the articles either side of it small
// and spaced, and the whole thing lit from behind.
const wordmark = (extra = '') => html`
  <span class="mark ${extra}">
    <b>tizen <i>homebrew</i></b>
  </span>`;

const masthead = (state) => html`
  <div class="bar">
    ${wordmark('mark-hero')}
    <span class="micro mono">${state.build ? `build ${state.build}` : ''}</span>
  </div>`;

// ── The two readouts ─────────────────────────────────────────────────────

// Six cells, always six, whether or not there is a code to put in them yet.
// A layout that appeared when the service answered would move everything
// under it at the exact moment someone is looking at it.
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

// ── Readiness ────────────────────────────────────────────────────────────

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

// ── The log ──────────────────────────────────────────────────────────────
//
// Three columns, and they are dmesg's three: when, which part of the system,
// and what happened.
//
//     [   12.345] pkg: staged 5.44 MB to /home/owner/…/package.wgt
//
// The timestamp is monotonic since the *service* started, not since this page
// opened — the service is the thing being reported on, and it outlives the
// page. It is printed to three decimals rather than dmesg's six because this
// is read from three metres, where microseconds are noise and milliseconds
// are still enough to see the gap between two lines.
//
// The facility column is what makes a thousand lines skimmable: `sdb` and
// `pkg` and `sock` are answers to "which part of this is talking", and the
// eye finds them without reading a word of the message beside them. It is set
// in the secondary ink rather than a colour of its own — it is scaffolding
// for the line, the way the timestamp is.
//
// On the main screen only the tail of this fits, and oldest lines fall off
// the top rather than scrolling. The whole of it is behind `show logs`.

const SPACES = '            ';

const stamp = (t) => {
    const seconds = ((Number(t) || 0) / 1000).toFixed(3);
    return `[${SPACES.slice(0, Math.max(0, 9 - seconds.length))}${seconds}]`;
};

// A line is three cells, not a row element containing three cells.
//
// The difference is the whole of the alignment. A grid per line sizes its own
// columns from its own content, so `relay:` sets a wider second column than
// `ui:` and every message in the log starts at a slightly different place —
// which is exactly the ragged left edge the columns exist to prevent. Three
// cells straight into one grid means all of them share the tracks, so the
// messages line up down the screen and a column only widens when something in
// it genuinely needs the room. `data-row` marks the first cell of each row,
// which is how tv.js counts how many rows fit.
const line = (entry) => html`
  <span class="mono stamp" data-row>${stamp(entry.t)}</span>
  <span class="mono facility">${entry.facility || 'svc'}:</span>
  <span class="tone-${entry.level || 'info'}">${entry.text}</span>`;

const log = (state) => html`
  <div class="feed log">
    ${state.lines.slice(-BAND).map(line)}
  </div>`;

// ── The legend ───────────────────────────────────────────────────────────

// Which key does what, printed. A television app has nowhere else to put
// that: there is no hover, no tooltip and no menu bar — and every screen
// here answers the keys differently, so each carries its own.
const legend = (keys) => html`
  <div class="legend">
    ${keys.map(([key, meaning]) => html`
      <span class="legend-key"><span class="key">${key}</span><span>${meaning}</span></span>`)}
  </div>`;

// ── Over the screen ──────────────────────────────────────────────────────
//
// Two screens that take the television over: the console and the credits.
// Both are one long list seen through a fixed window, and both are left by
// pressing Return — so both are built out of the same three parts, a header
// saying where in the list you are, the window, and the legend.

/**
 * The window an open overlay is showing: how many rows fit on screen, and
 * how many rows there are to move through.
 *
 * Exported because tv.js clamps the remote's scrolling against it. How much
 * of itself a screen shows stays the screen's own business.
 */
const windowOf = (state) => ({
    rows: state.rows || ROWS[state.view] || 0,
    total: state.view === 'credits' ? CREDITS.length : state.lines.length
});

/**
 * The rows on screen, and the index the first of them sits at.
 *
 * The clamp is here rather than only in tv.js because the list moves under
 * the window as well: a log line arriving while the console is parked near
 * the end would otherwise leave it showing a window off the end of the
 * buffer.
 */
const framed = (state, all, anchor) => {
    const { rows } = windowOf(state);
    const from = Math.max(0, Math.min(state.from, all.length - rows));

    // Which end the spare rows hang off, and it is not a detail.
    //
    // A log is anchored to its newest line the way `less` and every terminal
    // are: the spares are drawn *above* the window and clipped at the top, so
    // the line somebody opened the console to read sits on the pane's bottom
    // edge with nothing dead beneath it. Anchor a log the other way and the
    // newest line floats two rows short of the bottom, which is exactly the
    // band of empty glass this is here to remove.
    //
    // A document is the other way round. The credits start at their first
    // line, the spares go below, and the only page that does not fill the
    // pane is the last one — which is what the end of a document looks like.
    const ends = anchor === 'end';

    return {
        from,
        // What a person can read: what the header counts, and what a page of
        // the direction keys moves by.
        fits: Math.min(rows, all.length - from),
        // What is drawn, which runs past one edge or the other on purpose.
        shown: all.slice(ends ? Math.max(0, from - SPARE) : from, ends ? from + rows : from + rows + SPARE)
    };
};

// Where in the list this window is. Written out in full rather than as a
// scrollbar: a bar a few pixels wide is invisible from a sofa.
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

// How much of the log is a problem, without reading it.
//
// A count in the header is the difference between a log you have to scroll to
// judge and one you can judge from its first screen — and on a television,
// scrolling a thousand lines to find out whether anything went wrong is not
// something anybody will do.
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

// One row of the credits. Every kind is one line high, which is what lets
// the window above be a count of rows rather than a measurement.
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

// ── The foot ─────────────────────────────────────────────────────────────

// The controls the remote lands on, and under them the legend saying which
// key does what.

const deck = (state) => {
    // An overlay hides the screen in CSS, which is what puts these out of the
    // remote's reach — `core/remote.js` only considers what is laid out. This
    // says the same thing a second time in the one place a dropped rule would
    // otherwise strand focus on buttons nobody can see.
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
