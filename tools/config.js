'use strict';

// Single source of truth for build-time configuration.
//
// The catalogue origin used to be a hardcoded placeholder in the source. It
// now lives in tizen.config.json, is validated before any build starts, and is
// baked into the bundle so a TV never depends on an environment variable being
// set. HOMEBREW_CATALOG_URL still overrides, which is what CI and one-off
// builds use.

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'tizen.config.json');

const PLACEHOLDER_HOSTS = ['cdn.example.com', 'cdn.example.invalid', 'example.com'];

function fail(message) {
    const error = new Error(message);
    error.isConfigError = true;
    throw error;
}

function readConfigFile() {
    if (!existsSync(CONFIG_PATH)) {
        fail(`No tizen.config.json at the repository root.\n  Expected: ${CONFIG_PATH}`);
    }
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        fail(`tizen.config.json is not valid JSON: ${e.message}`);
    }
}

function validUrl(value, field) {
    let url;
    try {
        url = new URL(value);
    } catch (e) {
        fail(`${field} is not a valid URL: ${JSON.stringify(value)}`);
    }
    // https everywhere, except a loopback origin, which is how a local mirror
    // is exercised during development.
    const isLoopback = ['localhost', '127.0.0.1', '::1'].indexOf(url.hostname) !== -1;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
        fail(`${field} must use https, got ${url.protocol.replace(':', '')}: ${value}`);
    }
    return url;
}

function load(options) {
    const opts = options || {};
    const file = readConfigFile();

    const config = {
        version: process.env.HOMEBREW_VERSION || file.version,
        catalogUrl: process.env.HOMEBREW_CATALOG_URL || file.catalogUrl || ''
    };

    if (!/^\d+\.\d+\.\d+$/.test(String(config.version || ''))) {
        fail(`version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(config.version)}`);
    }

    const catalogUrl = validUrl(config.catalogUrl, 'catalogUrl');

    // A placeholder is fine while developing, but shipping one produces an app
    // whose catalogue is permanently empty — and the URL is baked in, so every
    // TV that installed it has to be reinstalled to change it. Release builds
    // refuse it.
    config.placeholders = PLACEHOLDER_HOSTS.indexOf(catalogUrl.hostname) !== -1 ? ['catalogUrl'] : [];

    if (config.placeholders.length && opts.requireReal) {
        fail(
            'catalogUrl still points at a placeholder host.\n' +
            '  Edit tizen.config.json, or set HOMEBREW_CATALOG_URL, before a release build.'
        );
    }

    return config;
}

module.exports = { load, CONFIG_PATH, ROOT, PLACEHOLDER_HOSTS };
