import './app.css';
import stylesheet from './app.css?inline';

import { html } from './core/view.js';
import { sea } from './scene/sea.js';
import { masthead, pairing, status, tabs, panel, outcome } from './views/screens.js';
import * as tv from './views/television.js';

// Every screen, side by side, with representative state.
//
// The real interface hides most of itself behind a PIN and the rest behind a
// television, which makes it impossible to judge as a whole while building
// it. This exists so the design can actually be *looked at* — which is the
// step whose absence produced the first version.
//
// It renders the same view functions the real pages do, so there is no second
// copy of any screen to drift out of date. The one thing it adds is the
// television's frame, and that is not decoration — see below.

// Stand-in artwork. There is no network here and no package to open, and what
// needs looking at is whether a tile holds its frame and a row of them holds
// together — not whose logo happens to be in it. One app is deliberately left
// without any, because a catalogue logo is guessed rather than declared and
// the monogram is the ordinary case.
const artwork = (letter, top, bottom) => `data:image/svg+xml;base64,${btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>` +
    '</linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>' +
    '<text x="32" y="45" text-anchor="middle" fill="#ffffff" font-weight="700" ' +
    `font-size="36" font-family="Helvetica,Arial,sans-serif">${letter}</text></svg>`
)}`;

const TUBE = artwork('Y', '#ff4d4d', '#9b0000');
const JELLYFIN = artwork('J', '#aa5cd6', '#00a4dc');
const HOMEBREW = artwork('H', '#7fe3ff', '#0a5f80');

// What the service read out of the package it is installing: the same shape
// whichever end read it — see install/preview.js and core/package.js.
const IDENTITY = {
    packageId: 'tUb3Xq7Lm9', appId: 'tUb3Xq7Lm9.Tube', name: 'YouTube',
    version: '0.1.0', isWgt: true, icon: TUBE
};

const base = {
    connection: 'connected', paired: true, pin: '', pinError: null, restoring: false, themeOn: true,
    device: { onTv: true, ready: true, platformVersion: '6.5' },
    catalog: [
        // The first row is the channel updating itself, which is the one state
        // in this list that is not just a button: the version beside the name
        // is what is on offer, the line under it is what would be replaced,
        // and the lit button is the only one on the screen. See
        // install/updates.js for the end that decides it.
        { id: 'homebrew', name: 'Tizen Homebrew', version: '0.2.0', installed: '0.1.0', update: true, description: 'This app. Updates itself.', icon: HOMEBREW, source: { type: 'github', ref: 'SushyDev/tizen-homebrew' } },
        { id: 'tube', name: 'YouTube', version: '0.1.0', description: 'YouTube without the advertisements', icon: TUBE, source: { type: 'github', ref: 'SushyDev/tube' } },
        { id: 'jellyfin', name: 'Jellyfin', version: '10.9.1', description: 'Your own media server', icon: JELLYFIN, source: { type: 'github', ref: 'jellyfin/jellyfin-tizen' } },
        { id: 'kodi', name: 'Kodi', version: '21.0', description: 'The media centre, ported', icon: null, source: { type: 'url', ref: 'https://example.invalid/Kodi.wgt' } }
    ],
    catalogStale: false, tab: 'catalog', github: '', url: '',
    usb: [
        { name: '..', path: '/media', isDirectory: true },
        { name: 'YouTube.wgt', path: '/media/usb1/YouTube.wgt', isDirectory: false, size: 2528154, identity: IDENTITY },
        { name: 'download (2).wgt', path: '/media/usb1/download (2).wgt', isDirectory: false, size: 8912896, identity: null }
    ],
    usbPath: '/media/usb1', file: null, reading: false, uploading: null, identity: null,
    relayEnabled: true, relayBusy: false, relayOutput: '$ pkgcmd -l\npkgid [tUb3Xq7Lm9]\n',
    phase: null, phaseDetail: null, done: null, error: null
};

const scenes = [
    ['Pairing', { ...base, paired: false }],
    ['Pairing · remembered', { ...base, paired: false, restoring: true }],
    ['Rejected', { ...base, paired: false, pinError: 'That PIN did not match.' }],
    ['Rejected · remembered', { ...base, paired: false, pinError: 'The TV has restarted, so its PIN has changed.' }],
    ['Ready', base],
    ['Not ready', { ...base, device: { onTv: true, ready: false, reason: 'sdbUnreachable' } }],
    // The three states a chosen file passes through: named by the browser,
    // being read, and read. The middle one lasts about a tenth of a second on
    // a phone and is still worth a scene — it is where the card first appears,
    // and it must not appear as a jump.
    ['Upload · chosen', { ...base, tab: 'upload', file: { name: 'download (2).wgt', size: 2528154 } }],
    ['Upload · reading', { ...base, tab: 'upload', reading: true, file: { name: 'download (2).wgt', size: 2528154 } }],
    ['Upload · read', { ...base, tab: 'upload', file: { name: 'download (2).wgt', size: 2528154 }, identity: IDENTITY }],
    ['Installing', { ...base, phase: 'installing', phaseDetail: 'YouTube', identity: IDENTITY }],
    ['Installed', { ...base, identity: IDENTITY, done: { name: 'YouTube', packageId: 'tUb3Xq7Lm9', version: '0.1.0' } }],
    // Three lines: what went wrong, what the television said, what to do. The
    // last is the one worth looking at — it wraps to four on a phone, and the
    // point of previewing it is that it has to stay readable there.
    ['Failed', { ...base, error: {
        title: 'A different build of this app is already installed.',
        detail: 'app_id[tUb3Xq7Lm9] install failed[118, -11], reason: Author certificate not match :',
        remedy: 'A copy signed by somebody else is already installed, and Tizen will not update ' +
            'across a changed author. Remove tUb3Xq7Lm9 from the TV\'s Apps menu — or run ' +
            '`vd_appuninstall tUb3Xq7Lm9` in the shell tab — then install again.'
    } }],
    ['Storage', { ...base, tab: 'usb' }],
    ['Shell', { ...base, tab: 'relay' }]
];

// The scene's own name, set in the signal colour so the harness is never
// mistaken for part of the interface.
const caption = (name) => html`<div class="label" style="color:var(--signal)">${name}</div>`;

const phone = ([name, state]) => html`
  <section style="padding-bottom:2rem;border-bottom:1px solid rgba(167,214,238,0.12)">
    <main class="page">
      ${caption(name)}
      ${masthead(state)}
      ${state.paired ? status(state) : pairing(state)}
      ${state.paired ? tabs(state) : ''}
      ${state.paired ? panel(state) : ''}
      ${state.paired ? outcome(state) : ''}
    </main>
  </section>`;

// ── The television ───────────────────────────────────────────────────────
//
// In an iframe at its true 1920×1080, scaled down to fit.
//
// The iframe is the point, not decoration: every size on the TV page is a
// fraction of the viewport, and a viewport unit inside *this* document would
// resolve against the browser window instead of the television. Only a real
// nested viewport of the right size tells the truth — and getting this wrong
// is precisely how a screen full of 17px text reached the living room.
//
// The sea cannot come with it: it is mounted by a script this frame does not
// run. So the frame paints the same gradient from the same custom properties,
// which is the one duplication in this file and is confined to one line.

const televisionState = {
    url: 'http://192.168.2.9:8091',
    pin: '386588',
    ready: true,
    build: '20260828-1',
    view: 'main',
    from: 0,
    themeOn: true,
    lines: [
        [312, 'svc', 'ok', 'startup finished in 312ms'],
        [318, 'dev', 'info', 'tizen 6.5'],
        [906, 'sdb', 'ok', 'loopback 127.0.0.1:26101 answered — this TV can install its own apps'],
        [910, 'cat', 'info', '3 apps from the cache, 41m old']
    ].map(([t, facility, level, text]) => ({ t, facility, level, text }))
};

// A real log, at the length one actually reaches: a boot, a phone arriving, a
// package fetched and installed, and one that the television refused. Every
// line here is one the service or the page genuinely writes — the console is
// impossible to judge against four tidy lines, and this is the screen most
// likely to be looked at on the evening something is wrong.
const history = [
    [3, 'svc', 'info', 'tizen homebrew 20260828-1 starting'],
    [4, 'svc', 'info', 'node v4.4.3 on linux/armv7l, pid 4127'],
    [4, 'auth', 'info', 'pairing pin 386588 — regenerated every start'],
    [5, 'cat', 'info', 'origin https://cdn.example.com/homebrew/catalog.json'],
    [5, 'cfg', 'info', 'cache /home/owner/share/homebrewCatalog.json'],
    [6, 'svc', 'info', 'serving the phone UI from /opt/usr/apps/GJBBYNLkgP/res/wgt/ui/dist'],
    [301, 'net', 'ok', 'listening on 0.0.0.0:8091'],
    [302, 'net', 'info', 'reachable at http://192.168.2.9:8091 (eth0)'],
    [312, 'svc', 'ok', 'startup finished in 312ms'],
    [318, 'dev', 'info', 'tizen 6.5'],
    [906, 'sdb', 'ok', 'loopback 127.0.0.1:26101 answered — this TV can install its own apps'],
    [910, 'cat', 'info', '3 apps from the cache, 41m old'],
    [1204, 'ui', 'ok', 'the service answered on port 8091'],
    [31402, 'sock', 'info', '192.168.2.31 connected (1 client)'],
    [33189, 'auth', 'warn', '192.168.2.31 gave the wrong PIN'],
    [38004, 'auth', 'ok', '192.168.2.31 paired'],
    [38210, 'http', 'info', '192.168.2.31 GET / 200 38.4 kB 41ms'],
    [39880, 'sock', 'info', '192.168.2.31 getCatalog'],
    [40122, 'cat', 'ok', '3 apps in 241ms'],
    [52001, 'sock', 'info', '192.168.2.31 asked to install github SushyDev/tube'],
    [52002, 'pkg', 'info', 'install requested: github SushyDev/tube'],
    [52340, 'pkg', 'info', 'television is tizen 6.5, sdb reachable'],
    [52341, 'pkg', 'info', 'asking github for the latest release of SushyDev/tube'],
    [53102, 'pkg', 'info', 'release v0.1.4 carries tube.wgt (2.41 MB)'],
    [53103, 'pkg', 'info', 'downloading github.com/SushyDev/tube/releases/download/v0.1.4/tube.wgt'],
    [54711, 'pkg', 'ok', 'got tube.wgt: 2.41 MB in 1.61s (1.50 MB/s)'],
    [54804, 'pkg', 'info', 'sha256 3f2a91c0d84b17e6…'],
    [54890, 'pkg', 'info', 'identified Tube 0.1.0 (tUb3Xq7Lm9, app tUb3Xq7Lm9.Tube, wgt)'],
    [55020, 'pkg', 'ok', 'staged 2.41 MB to /home/owner/share/tmp/sdk_tools/package.wgt'],
    [55021, 'sdb', 'info', 'shell:0 vd_appinstall tUb3Xq7Lm9 /home/owner/share/tmp/sdk_tools/package.wgt'],
    [59214, 'sdb', 'info', 'spend time for wgt injection: 4.19 sec'],
    [59215, 'sdb', 'ok', 'vd_appinstall finished in 4.19s'],
    [59220, 'pkg', 'ok', 'installed Tube 0.1.0 in 7.22s'],
    [88400, 'sock', 'info', '192.168.2.31 asked to install catalog jellyfin'],
    [88401, 'pkg', 'info', 'install requested: catalog jellyfin'],
    [88402, 'pkg', 'info', 'catalogue entry "jellyfin" is github jellyfin/jellyfin-tizen'],
    [91655, 'pkg', 'ok', 'got Jellyfin.wgt: 8.10 MB in 3.25s (2.49 MB/s)'],
    [92110, 'pkg', 'ok', 'staged 8.10 MB to /home/owner/share/tmp/sdk_tools/package.wgt'],
    [96330, 'sdb', 'info', 'app install failed[118, -14]'],
    [96331, 'pkg', 'err', 'install failed after 7.93s: installFailed — app install failed[118, -14]'],
    [96340, 'sock', 'warn', '192.168.2.31 refused: installFailed — app install failed[118, -14]'],
    [120044, 'sock', 'info', '192.168.2.31 disconnected the page went away after 81.6s (0 clients)'],
    [180500, 'sdb', 'warn', 'loopback 127.0.0.1:26101 is not usable (sdbReset)'],
    [180501, 'dev', 'warn', 'set Host PC IP to 127.0.0.1 in Apps › 12345 › Settings, then restart the TV'],
    [180502, 'dev', 'info', 'sdbd only reads that value at startup, which is why the restart is not optional']
].map(([t, facility, level, text]) => ({ t, facility, level, text }));

// The television three ways: the channel, and each of the two screens that
// open over it. The overlays are rendered into a section that sits *before*
// the screen, exactly as tv.html orders them — app.css hides the channel
// with an adjacent-sibling rule, so getting that order wrong here would
// preview a screen the television never shows.
const televisions = [
    ['Television · the channel', televisionState],
    ['Television · the log', { ...televisionState, lines: history, view: 'logs', from: 20 }],
    ['Television · the credits', { ...televisionState, view: 'credits', from: 0 }]
];

const screenMarkup = (state) => html`
  <div class="sea"></div>
  <section id="overlay">${tv.overlay(state)}</section>
  <div class="screen">
    ${tv.masthead(state)}
    ${tv.connect(state)}
    ${tv.status(state)}
    ${tv.log(state)}
    ${tv.deck(state)}
  </div>`;

const television = ([name, state]) => html`
  <section style="padding:1.5rem 1rem;display:grid;gap:1.25rem;justify-items:center">
    ${caption(`${name} · 1920×1080, shown at half size`)}
    <div style="width:960px;height:540px;max-width:100%;overflow:hidden;border-radius:0.5rem;
                border:1px solid var(--pane-edge);box-shadow:var(--lift)">
      <iframe title="${name}" style="width:1920px;height:1080px;border:0;transform:scale(0.5);transform-origin:top left"
              srcdoc="${`<!doctype html><html><head><meta charset='utf-8'><style>${stylesheet}</style></head><body class='tv'>${screenMarkup(state).__markup}</body></html>`}"></iframe>
    </div>
  </section>`;

// The harness gets the real ocean behind it too — partly because every screen
// below is translucent and would otherwise be judged against nothing, and
// partly because the bubbles are the thing most worth watching while tuning.
sea();

document.getElementById('preview').innerHTML =
    televisions.map((set) => television(set).__markup).join('') +
    scenes.map((scene) => phone(scene).__markup).join('');
