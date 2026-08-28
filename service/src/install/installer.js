'use strict';

// Putting a package on disk and asking the TV to install it.
//
// Because this service runs *on* the TV, staging is an ordinary file write.
// The reference implementation had to reimplement the ADB sync protocol by
// hand — STAT/SEND/DATA/DONE frames in 1420-byte chunks — to push packages
// from a laptop. Running on-device deletes that code and the race it carried.

const { writeFileSync, mkdirSync, statSync } = require('fs');

const { interpret, settled } = require('./verdicts.js');

const STAGING_DIR = '/home/owner/share/tmp/sdk_tools';
const INSTALL_TIMEOUT = 180000;

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
 * Runs the installer and hands what it said to verdicts.js.
 *
 * Waiting and reading come from the same table there, so a verdict this can
 * explain is a verdict it also knows to stop waiting for. The package id goes
 * with it because two of the explanations name the package that has to be
 * removed before the install can work.
 */
const run = (session, path, packageId) =>
    session.exec(`shell:0 vd_appinstall ${packageId} ${path}`, {
        timeout: INSTALL_TIMEOUT,
        until: settled
    }).then((output) => interpret(output, { packageId }));

module.exports = { stage, run, STAGING_DIR };
