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

// How long to wait for the set to say what is on it.
//
// getPackagesInfo takes no timeout of its own and neither of its callbacks is
// guaranteed to fire. It is slow enough on a full television — six seconds for
// three hundred packages, measured — that a caller cannot tell "slow" from
// "never" by waiting a little longer, and a call that never came back would
// wedge whatever awaited it for the life of the service. So it is given a
// generous deadline and then abandoned.
const LIST_TIMEOUT = 30000;

const offTv = () => Object.assign(new Error('Only available on a TV.'), { code: 'notOnTv' });

/** Everything installed, as plain data. */
const list = () => {
    if (!onTv) return Promise.reject(offTv());

    return new Promise((resolve, reject) => {
        const gaveUp = setTimeout(() => reject(Object.assign(
            new Error(`The TV did not answer getPackagesInfo within ${LIST_TIMEOUT / 1000}s.`),
            { code: 'internal' }
        )), LIST_TIMEOUT);

        // Whichever of the three lands first wins; the other two become no-ops
        // on an already-settled promise.
        const done = (finish) => (value) => {
            clearTimeout(gaveUp);
            finish(value);
        };

        tizen.package.getPackagesInfo(
            done((packages) => resolve(packages.map((entry) => ({
                id: entry.id,
                name: entry.name,
                version: entry.version,
                totalSize: entry.totalSize,
                lastModified: entry.lastModified ? new Date(entry.lastModified).toISOString() : null
            })))),
            done((error) => reject(Object.assign(new Error(`Could not list packages: ${error.message}`), { code: 'internal' })))
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
