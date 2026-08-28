// Whose work this is made of.
//
// The channel is a rebuild of somebody else's screen, running on somebody
// else's protocol, next to an app that is a rewrite of somebody else's app.
// None of that is hidden anywhere in the interface, so it is said here,
// on a screen a person can actually reach with the remote.
//
// One row is one line on the television, which is what keeps the roll
// readable from three metres and what lets `views/television.js` window it
// without measuring anything:
//
//   { head }              a section rule
//   { note }              a line of prose under the entry above it
//   { name, by, at }      the work, who made it, and where it lives
//
// `at` is written without a scheme. Nothing on this screen is clickable —
// it is read off a television and typed into a phone — and `https://` in
// front of every one of them is four characters of noise repeated forty
// times.

const CREDITS = [
    { note: 'Tizen Homebrew is assembled almost entirely out of other people’s work.' },

    { head: 'Prior work on Tizen' },
    { name: 'TizenBrew', by: 'reisxd', at: 'github.com/reisxd/TizenBrew' },
    { name: 'TizenBrew Installer', by: 'reisxd', at: 'github.com/reisxd/TizenBrewInstaller' },
    { name: 'tizen.js', by: 'reisxd', at: 'github.com/reisxd/tizen.js' },

    { head: 'Artwork and sound' },
    { name: 'The Homebrew Channel', by: 'fail0verflow', at: 'github.com/fail0verflow/hbc' },
    { note: 'The sea, the rays, the bubbles, the glass and the banner music are all its own.' },
    { name: 'Make Aero', by: 'Visnalize', at: 'github.com/visnalize/makeaero' },
    { note: 'The Frutiger Aero gloss every pane and button is finished with.' },

    { head: 'Code that is shipped' },
    { name: 'adbhost', by: 'Andrey Sidorov', at: 'github.com/sidorares/node-adbhost' },
    { note: 'The ADB wire protocol, vendored and repaired — service/src/tv/adb.js.' },
    { name: 'ws', by: 'Einar Otto Stangvik', at: 'github.com/websockets/ws' },
    { name: 'express', by: 'TJ Holowaychuk', at: 'github.com/expressjs/express' },
    { name: 'cors', by: 'Troy Goode', at: 'github.com/expressjs/cors' },
    { name: 'node-fetch', by: 'David Frank', at: 'github.com/bitinn/node-fetch' },
    { name: 'peer-dial', by: 'Louay Bassbouss, Patrick Kan', at: 'github.com/patrickkfkan/peer-dial' },
    { name: 'chrome-remote-interface', by: 'Andrea Cardaci', at: 'github.com/cyrus-and/chrome-remote-interface' },
    { name: 'uuid', by: 'uuidjs', at: 'github.com/uuidjs/uuid' },
    { name: 'core-js', by: 'Denis Pushkarev', at: 'github.com/zloirock/core-js' },
    { name: 'whatwg-fetch', by: 'GitHub', at: 'github.com/JakeChampion/fetch' },
    { name: 'regenerator-runtime', by: 'Ben Newman', at: 'github.com/facebook/regenerator' },
    { name: 'tiny-sha256', by: 'Geraint Luff', at: 'npmjs.com/package/tiny-sha256' },
    { name: 'DOMRect polyfill', by: 'Financial Times', at: 'github.com/Financial-Times/polyfill-library' },

    { head: 'Code that builds it' },
    { name: 'Vite', by: 'Evan You', at: 'vite.dev' },
    { name: 'vite-plugin-singlefile', by: 'Richard Tallent', at: 'github.com/richardtallent/vite-plugin-singlefile' },
    { name: 'Rollup', by: 'Rich Harris', at: 'rollupjs.org' },
    { name: 'Rolldown', at: 'rolldown.rs' },
    { name: 'Babel', at: 'babeljs.io' },
    { name: 'PostCSS Preset Env', by: 'CSSTools', at: 'preset-env.cssdb.org' },
    { name: 'ncc', by: 'Vercel', at: 'github.com/vercel/ncc' },
    { name: 'Acorn', at: 'github.com/acornjs/acorn' },
    { name: 'ESLint', by: 'Nicholas C. Zakas', at: 'eslint.org' },

    { head: 'And' },
    { note: 'Everyone who worked out what a Samsung TV will and will not allow, and' },
    { note: 'then wrote it down where somebody else could find it.' }
];

export { CREDITS };
