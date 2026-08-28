'use strict';

// Putting a package on disk and asking the TV to install it.
//
// Because this service runs *on* the TV, staging is an ordinary file write.
// The reference implementation had to reimplement the ADB sync protocol by
// hand — STAT/SEND/DATA/DONE frames in 1420-byte chunks — to push packages
// from a laptop. Running on-device deletes that code and the race it carried.

const { writeFileSync, mkdirSync, statSync } = require('fs');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';
const INSTALL_TIMEOUT = 180000;

// vd_appinstall keeps its stream open after it finishes, so completion has to
// be read out of the output rather than waited for on the stream.
const SUCCEEDED = 'spend time';
const FAILED = 'install failed';
const CERTIFICATE_REJECTED = 'Check certificate error';

const problem = (code, message) => Object.assign(new Error(message), { code });

/** Writes the package where the installer expects to find it. */
const stage = (archive, { isWgt }) => {
    const path = `${STAGING_DIR}/package.${isWgt ? 'wgt' : 'tpk'}`;

    mkdirSync(STAGING_DIR, { recursive: true });
    writeFileSync(path, archive);

    const written = statSync(path).size;

    if (written !== archive.length) {
        throw problem('internal', `Staged ${written} bytes but the package is ${archive.length}.`);
    }

    return path;
};

/**
 * Reads a verdict out of vd_appinstall's output.
 *
 * Its exit status is not available over an sdb shell stream, so the text is
 * all there is — and an empty string is not success. That distinction matters:
 * treating "no error seen" as "installed" once let a failed install be
 * reported as a success.
 */
const interpret = (output) => {
    const text = output || '';

    if (text.includes(CERTIFICATE_REJECTED)) {
        throw problem('certRejected',
            'The TV rejected the package signature. The stored certificates are stale and should be recreated.');
    }

    const failureLine = text.split('\n').find((line) => line.includes(FAILED));
    if (failureLine) throw problem('installFailed', failureLine.trim());

    if (!text.includes(SUCCEEDED)) {
        throw problem('installFailed',
            `The installer reported neither success nor failure. Output: ${text.trim().slice(-400) || '(empty)'}`);
    }

    return { output: text };
};

/** Runs the installer over an sdb session and interprets what it says. */
const run = (session, path, packageId) =>
    session.exec(`shell:0 vd_appinstall ${packageId} ${path}`, {
        timeout: INSTALL_TIMEOUT,
        until: (output) =>
            output.includes(SUCCEEDED) || output.includes(FAILED) || output.includes(CERTIFICATE_REJECTED)
    }).then(interpret);

module.exports = { stage, run, interpret, STAGING_DIR };
