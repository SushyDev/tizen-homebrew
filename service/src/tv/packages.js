'use strict';

// Installed packages, read off the disk and named by the platform.
//
// Listing only. Removing one needs packagemanager.install, which requires a
// platform-level certificate — signing with ours produces a package the TV
// refuses to install at all:
//
//   MISMATCHED_PRIVILEGE_LEVEL - http://tizen.org/privilege/packagemanager.install
//   >> Use at least platform signatured certificate.
//
// So uninstalling is done from the TV's own app list, and no code here
// pretends otherwise.

// `fs.promises`, not `require('fs/promises')`. The bare specifier is a Node 14
// addition and throws MODULE_NOT_FOUND on the floor this service targets —
// which is Node 12, and is what the television actually runs. It cost a build
// that installed cleanly, launched, and never opened its port, with no log to
// say why because the service died before it could write one.
const { readdir, readFile } = require('fs').promises;
const { join } = require('path');

// `typeof` and not `globalThis.tizen`: a runtime may hand it over as a binding.
const platform = () => (typeof tizen !== 'undefined' ? tizen : undefined);

const onTv = () => platform() !== undefined;

const offTv = () => Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' });

// Where the platform unpacks what it installs: one directory per package,
// named by package id — which is the key an app list matches on.
const APPS_ROOT = '/opt/usr/apps';

// The manifest inside a package that carries its version. A web app keeps one
// where the runtime unpacked it; a native package keeps its own at the root.
const MANIFESTS = ['res/wgt/config.xml', 'tizen-manifest.xml'];

const NAMING_DEADLINE = 4000;

const attribute = (xml, name) => {
    const found = new RegExp(`<(?:widget|manifest)\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
    return found ? found[1] : null;
};

const elementText = (xml, name) => {
    const found = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`).exec(xml);
    return found ? found[1].trim() : null;
};

/** What a package's own manifest says about it, or nulls when unreadable. */
const describe = async (id, root) => {
    for (const relative of MANIFESTS) {
        try {
            const xml = await readFile(join(root, id, relative), 'utf8');
            return { version: attribute(xml, 'version'), name: elementText(xml, 'name') };
        } catch (e) {
            // The next candidate, or nothing. Another app's directory is
            // readable but its files are not, which is most of this set.
        }
    }

    return { version: null, name: null };
};

// Turned off for the rest of the process the first time the platform refuses
// or stalls, so one bad call costs one deadline rather than one per listing.
let naming = true;

// At info, not debug: a television drops debug records, so a figure logged there
// is invisible on the only machine it describes.
let reported = false;

/**
 * Names and versions from `tizen.application`, as package id -> `{ name, version }`.
 *
 * Never rejects: every failure is an empty map and the manifests answer instead.
 * The deadline covers a slow device API, not one that blocks the thread.
 */
const named = (say) => new Promise((resolve) => {
    const api = platform();

    if (!naming || !api || !api.application || typeof api.application.getAppsInfo !== 'function') {
        return resolve(new Map());
    }

    let settled = false;

    const give = (value, note) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (note) {
            naming = false;
            if (say) say.info(`tizen.application.getAppsInfo ${note} — falling back to manifests`);
        }
        resolve(value);
    };

    const timer = setTimeout(() => give(new Map(), `did not answer in ${NAMING_DEADLINE}ms`), NAMING_DEADLINE);

    // One package can hold several applications; the versioned one wins.
    const collapse = (apps) => (apps || []).reduce((byPackage, app) => {
        const id = app && (app.packageId || app.id);
        const held = id ? byPackage.get(id) : null;

        if (id && !(held && held.version)) {
            byPackage.set(id, { name: app.name || null, version: app.version || null });
        }

        return byPackage;
    }, new Map());

    try {
        api.application.getAppsInfo(
            (apps) => give(collapse(apps)),
            (error) => give(new Map(), `refused (${(error && error.message) || 'no reason given'})`)
        );
    } catch (error) {
        give(new Map(), `threw (${error.message})`);
    }
});

/**
 * Everything installed, read off the disk.
 *
 * Two other sources were tried on a QE65S93DAT and neither can replace this.
 *
 * `tizen.package.getPackagesInfo` blocks the JS thread for about five minutes
 * — not slowly, entirely: no callback, and not even the deadline that was
 * meant to catch it, which is the tell. The service answers nothing for the
 * duration while the port keeps accepting TCP, because the kernel does that
 * without asking the process.
 *
 * `pkgcmd -l` over the TV's own sdb returns nothing, and it is the channel
 * rather than the command: `shell:0` on that firmware carries output for
 * Samsung's own commands — `getduid` and `vd_appinstall` both answer — and is
 * mute for the rest. `pkgcmd -l; echo marker` came back empty, marker and all.
 *
 * So the directory listing alone decides what is installed: a package a device
 * API left out would read as one that is not there, costing a row rather than a
 * version. `tizen.application.getAppsInfo` is a different subsystem from the
 * package API and is asked only to fill in names and versions, which most of
 * these entries lack — another app's directory is listable, its manifest is not.
 */
const listOnDisk = async (options) => {
    const opts = options || {};
    const root = opts.appsRoot || APPS_ROOT;
    const say = opts.say || null;

    // `.recovery` and `.pptestfw` sit alongside the real ones.
    const ids = (await readdir(root).catch(() => [])).filter((name) => name[0] !== '.');

    const fromPlatform = await named(say);

    const found = [];

    // Asynchronous throughout, and that is not a style preference. A set holds
    // three hundred packages, each of which is a directory read and up to two
    // file reads; done synchronously that is six hundred blocking calls with
    // the whole service stopped behind them, and the television's own page
    // polls its log once a second. Every await here is a chance for that poll
    // to be answered.
    //
    for (const id of ids) {
        const known = fromPlatform.get(id);
        const { version, name } = known && (known.version || known.name) ? known : await describe(id, root);

        found.push({ id, name: name || id, version, totalSize: null, lastModified: null });
    }

    if (say && !reported && fromPlatform.size) {
        reported = true;

        const covered = ids.filter((id) => fromPlatform.has(id)).length;
        const versioned = found.filter((entry) => entry.version).length;

        say.info(`tizen.application named ${covered}/${ids.length} packages; ` +
            `${versioned} of ${ids.length} now carry a version`);
    }

    return found;
};

/** Everything installed, as plain data. */
const list = (options) => (onTv() ? listOnDisk(options) : Promise.reject(offTv()));

/**
 * Launches an installed app.
 *
 * Used after an update, and to bring Tizen Homebrew's own service back once it exits
 * to reload new code.
 */
const launch = (appId) => {
    if (!onTv()) return Promise.reject(offTv());

    return new Promise((resolve, reject) => {
        try {
            platform().application.launch(
                appId,
                () => resolve({ appId, launched: true }),
                (error) => reject(Object.assign(new Error(`Could not launch ${appId}: ${error.message}`), { code: 'internal' }))
            );
        } catch (error) {
            reject(Object.assign(new Error(`Could not launch ${appId}: ${error.message}`), { code: 'internal' }));
        }
    });
};

module.exports = { list, launch, onTv, APPS_ROOT, NAMING_DEADLINE };
