'use strict';

// Persisted state: the Samsung certificates minted for this TV, plus user
// preferences. Lives beside the app's own data so it survives reinstalls.

const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } = require('fs');
const { homedir } = require('os');

// On a TV homedir() is /home/owner, so this lands in /home/owner/share
// alongside the other app data. Overridable so tests never touch real state.
const CONFIG_DIR = process.env.HOMEBREW_CONFIG_DIR || `${homedir()}/share`;
const CONFIG_PATH = `${CONFIG_DIR}/homebrewConfig.json`;

// Where `npm run bootstrap` leaves a certificate pair for the first start to
// pick up. A separate file rather than the config itself, so writing it cannot
// clobber a catalogue URL or an install history already there — and in the
// staging directory rather than beside the config, because sdb answers
// "You cannot push files to this path" for everything else under share/.
const HANDOFF_PATH = `${CONFIG_DIR}/tmp/sdk_tools/homebrewCerts.json`;

const DEFAULTS = {
    // `{ certificates: [pem], key: pem }` each. PEM rather than the .p12 they
    // were minted as: reading a PKCS#12 needs an ASN.1 parser, and that parser
    // was a third of the service bundle. tools/certificates.js converts.
    author: null,
    distributor: null,
    certDuid: null,          // the first DUID the certificates name, for display
    certDuids: null,         // every DUID they name — `--duidList` is a list
    certCreatedAt: null,
    catalogUrl: null,        // overrides the built-in origin when set
    lastInstalled: []
};

function read() {
    if (!existsSync(CONFIG_PATH)) return Object.assign({}, DEFAULTS);
    try {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
        return Object.assign({}, DEFAULTS, parsed);
    } catch (e) {
        // A truncated write must not brick the app; fall back to defaults and
        // let the next write replace the damaged file.
        console.error(`Config at ${CONFIG_PATH} is unreadable, using defaults: ${e.message}`);
        return Object.assign({}, DEFAULTS);
    }
}

// Written via a temporary file so an interrupted write cannot leave a
// half-serialised config behind.
function write(config) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR);
    const tmp = `${CONFIG_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 4));
    renameSync(tmp, CONFIG_PATH);
    return config;
}

function update(patch) {
    return write(Object.assign(read(), patch));
}

// True when we hold certificates usable for resigning on this TV. Certificates
// are bound to a DUID, so ones minted for a different TV are worthless.
function hasCertificates(duid) {
    const config = read();
    if (!config.author || !config.distributor) return false;

    // A pair that names this TV among several is as usable here as one minted
    // for it alone. Configs written before certDuids existed recorded only the
    // first name, so they are read as a list of one rather than ignored.
    const named = config.certDuids || (config.certDuid ? [config.certDuid] : []);

    if (duid && named.length && named.indexOf(duid) === -1) return false;
    return true;
}

function forgetCertificates() {
    return update({
        author: null,
        distributor: null,
        certDuid: null,
        certDuids: null,
        certCreatedAt: null
    });
}

// A pair stored by a build from before PEM. Nothing can be done with it here,
// and saying so is the difference between "send the pair again" and an install
// that fails at the end for no stated reason.
function hasLegacyCertificates() {
    const config = read();
    return Boolean(!config.author && (config.authorCert || config.distributorCert));
}

/**
 * Takes in a pair left by bootstrap, if there is one, and returns what it named.
 *
 * This is what removes `npm run certs` from a first install: bootstrap is
 * already holding the certificates and already talking to the television, so it
 * writes them where the service will find them rather than asking somebody to
 * read a PIN off a screen and send them again.
 *
 * Idempotent, because deleting the file is allowed to fail.
 */
function adoptHandoff() {
    if (!existsSync(HANDOFF_PATH)) return null;

    try {
        const sent = JSON.parse(readFileSync(HANDOFF_PATH, 'utf8'));

        if (!sent.author || !sent.distributor) return null;

        const devices = Array.isArray(sent.devices) ? sent.devices.filter(Boolean) : [];

        update({
            author: sent.author,
            distributor: sent.distributor,
            certDuid: devices[0] || null,
            certDuids: devices,
            certCreatedAt: new Date().toISOString()
        });

        return devices;
    } catch (e) {
        return null;
    } finally {
        try {
            unlinkSync(HANDOFF_PATH);
        } catch (e) { /* a read-only drop is re-adopted next start, harmlessly */ }
    }
}

function clear() {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

module.exports = {
    read,
    write,
    update,
    hasCertificates,
    hasLegacyCertificates,
    adoptHandoff,
    forgetCertificates,
    clear,
    CONFIG_PATH,
    HANDOFF_PATH,
    DEFAULTS
};
