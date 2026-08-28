'use strict';

// Persisted state: the Samsung certificates minted for this TV, plus user
// preferences. Lives beside the app's own data so it survives reinstalls.

const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } = require('fs');
const { homedir } = require('os');

// On a TV homedir() is /home/owner, so this lands in /home/owner/share
// alongside the other app data. Overridable so tests never touch real state.
const CONFIG_DIR = process.env.HOMEBREW_CONFIG_DIR || `${homedir()}/share`;
const CONFIG_PATH = `${CONFIG_DIR}/homebrewConfig.json`;

const DEFAULTS = {
    authorCert: null,        // base64 of the DER .p12
    distributorCert: null,   // base64 of the DER .p12
    password: null,          // generated when the certificates are created
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
    if (!config.authorCert || !config.distributorCert || !config.password) return false;

    // A pair that names this TV among several is as usable here as one minted
    // for it alone. Configs written before certDuids existed recorded only the
    // first name, so they are read as a list of one rather than ignored.
    const named = config.certDuids || (config.certDuid ? [config.certDuid] : []);

    if (duid && named.length && named.indexOf(duid) === -1) return false;
    return true;
}

function forgetCertificates() {
    return update({
        authorCert: null,
        distributorCert: null,
        password: null,
        certDuid: null,
        certDuids: null,
        certCreatedAt: null
    });
}

function clear() {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

module.exports = {
    read,
    write,
    update,
    hasCertificates,
    forgetCertificates,
    clear,
    CONFIG_PATH,
    DEFAULTS
};
