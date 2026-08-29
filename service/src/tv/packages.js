'use strict';

// Installed packages, read off the disk.
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

const onTv = typeof tizen !== 'undefined';

const offTv = () => Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' });

// Where the platform unpacks what it installs: one directory per package,
// named by package id — which is the key an app list matches on.
const APPS_ROOT = '/opt/usr/apps';

// The manifest inside a package that carries its version. A web app keeps one
// where the runtime unpacked it; a native package keeps its own at the root.
const MANIFESTS = ['res/wgt/config.xml', 'tizen-manifest.xml'];

const attribute = (xml, name) => {
    const found = new RegExp(`<(?:widget|manifest)\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
    return found ? found[1] : null;
};

const elementText = (xml, name) => {
    const found = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`).exec(xml);
    return found ? found[1].trim() : null;
};

/** What a package's own manifest says about it, or nulls when unreadable. */
const describe = async (id) => {
    for (const relative of MANIFESTS) {
        try {
            const xml = await readFile(join(APPS_ROOT, id, relative), 'utf8');
            return { version: attribute(xml, 'version'), name: elementText(xml, 'name') };
        } catch (e) {
            // The next candidate, or nothing. Another app's directory is
            // readable but its files are not, which is most of this set.
        }
    }

    return { version: null, name: null };
};

/**
 * Everything installed, read off the disk.
 *
 * Two other sources were tried on a QE65S93DAT and neither can be used.
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
 * A directory listing is neither. It is a local read of a path this service
 * already reads out of, it cannot block, and the names it returns are already
 * the ids to match on. A package whose manifest cannot be read still counts
 * as installed with no version: knowing something is on the set is most of
 * the value, and a missing version costs an update mark rather than a row.
 */
const listOnDisk = async () => {
    // Asynchronous throughout, and that is not a style preference. A set holds
    // three hundred packages, each of which is a directory read and up to two
    // file reads; done synchronously that is six hundred blocking calls with
    // the whole service stopped behind them, and the television's own page
    // polls its log once a second. Every await here is a chance for that poll
    // to be answered.
    const names = await readdir(APPS_ROOT).catch(() => []);

    const found = [];

    // `.recovery` and `.pptestfw` sit alongside the real ones.
    for (const id of names.filter((name) => name[0] !== '.')) {
        const { version, name } = await describe(id);

        found.push({ id, name: name || id, version, totalSize: null, lastModified: null });
    }

    return found;
};

/** Everything installed, as plain data. */
const list = () => (onTv ? listOnDisk() : Promise.reject(offTv()));

/**
 * Launches an installed app.
 *
 * Used after an update, and to bring Tizen Homebrew's own service back once it exits
 * to reload new code.
 */
const launch = (appId) => {
    if (!onTv) return Promise.reject(offTv());

    return new Promise((resolve, reject) => {
        try {
            tizen.application.launch(
                appId,
                () => resolve({ appId, launched: true }),
                (error) => reject(Object.assign(new Error(`Could not launch ${appId}: ${error.message}`), { code: 'internal' }))
            );
        } catch (error) {
            reject(Object.assign(new Error(`Could not launch ${appId}: ${error.message}`), { code: 'internal' }));
        }
    });
};

module.exports = { list, launch, onTv };
