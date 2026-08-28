'use strict';

// Installed packages, through the Tizen platform API.
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

const onTv = typeof tizen !== 'undefined';

const offTv = () => Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' });

/** Everything installed, as plain data. */
const list = () => {
    if (!onTv) return Promise.reject(offTv());

    return new Promise((resolve, reject) => {
        tizen.package.getPackagesInfo(
            (packages) => resolve(packages.map((entry) => ({
                id: entry.id,
                name: entry.name,
                version: entry.version,
                totalSize: entry.totalSize,
                lastModified: entry.lastModified ? new Date(entry.lastModified).toISOString() : null
            }))),
            (error) => reject(Object.assign(new Error(`Could not list packages: ${error.message}`), { code: 'internal' }))
        );
    });
};

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
