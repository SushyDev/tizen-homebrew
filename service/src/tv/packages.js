'use strict';

// Listing only: removing a package needs packagemanager.install, which requires a platform-level certificate.

// `fs.promises`, not `require('fs/promises')`: the bare specifier is Node 14 and the television runs Node 12.
const { readdir, readFile } = require('fs').promises;
const { join } = require('path');

// `typeof` and not `globalThis.tizen`: a runtime may hand it over as a binding.
const platform = () => (typeof tizen !== 'undefined' ? tizen : undefined);

const onTv = () => platform() !== undefined;

const offTv = () => Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' });

const APPS_ROOT = '/opt/usr/apps';

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

const describe = async (id, root) => {
    for (const relative of MANIFESTS) {
        try {
            const xml = await readFile(join(root, id, relative), 'utf8');
            return { version: attribute(xml, 'version'), name: elementText(xml, 'name') };
        } catch (e) {
            // The next candidate, or nothing. Another app's directory is readable but its files are not.
        }
    }

    return { version: null, name: null };
};

let naming = true;

let reported = false;

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

// The directory listing alone decides what is installed: getPackagesInfo blocks the JS thread for about
// five minutes on a QE65S93DAT, and `pkgcmd -l` over sdb returns nothing at all. getAppsInfo is a
// different subsystem, asked only to fill in names and versions.
const listOnDisk = async (options) => {
    const opts = options || {};
    const root = opts.appsRoot || APPS_ROOT;
    const say = opts.say || null;

    // `.recovery` and `.pptestfw` sit alongside the real ones.
    const ids = (await readdir(root).catch(() => [])).filter((name) => name[0] !== '.');

    const fromPlatform = await named(say);

    const found = [];

    // Asynchronous throughout: three hundred packages is six hundred blocking calls done otherwise.
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

const list = (options) => (onTv() ? listOnDisk(options) : Promise.reject(offTv()));

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
