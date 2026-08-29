'use strict';

const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } = require('fs');
const { homedir } = require('os');

const CONFIG_DIR = process.env.HOMEBREW_CONFIG_DIR || `${homedir()}/share`;
const CONFIG_PATH = `${CONFIG_DIR}/homebrewConfig.json`;

// Where `npm run bootstrap` leaves a pair: sdb refuses to write anywhere else under share/.
const HANDOFF_PATH = `${CONFIG_DIR}/tmp/sdk_tools/homebrewCerts.json`;

const DEFAULTS = {
    // `{ certificates: [pem], key: pem }` each. PEM, because an ASN.1 parser was a third of the bundle.
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
        console.error(`Config at ${CONFIG_PATH} is unreadable, using defaults: ${e.message}`);
        return Object.assign({}, DEFAULTS);
    }
}

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

function hasCertificates(duid) {
    const config = read();
    if (!config.author || !config.distributor) return false;

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

function hasLegacyCertificates() {
    const config = read();
    return Boolean(!config.author && (config.authorCert || config.distributorCert));
}

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
