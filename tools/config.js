'use strict';

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
    const isLoopback = ['localhost', '127.0.0.1', '::1'].indexOf(url.hostname) !== -1;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
        fail(`${field} must use https, got ${url.protocol.replace(':', '')}: ${value}`);
    }
    return url;
}

// A placeholder catalogue URL is fine while developing and is refused by a release build: the URL
// is baked into every TV that installs the package.
function load(options) {
    const opts = options || {};
    const file = readConfigFile();

    const config = {
        version: process.env.HOMEBREW_VERSION || file.version,
        catalogUrl: process.env.HOMEBREW_CATALOG_URL || file.catalogUrl || '',

        dev: process.env.HOMEBREW_DEV === '1'
    };

    if (!/^\d+\.\d+\.\d+$/.test(String(config.version || ''))) {
        fail(`version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(config.version)}`);
    }

    const catalogUrl = validUrl(config.catalogUrl, 'catalogUrl');

    config.placeholders = PLACEHOLDER_HOSTS.indexOf(catalogUrl.hostname) !== -1 ? ['catalogUrl'] : [];

    if (config.dev && opts.requireReal) {
        fail(
            'This is a developer build (HOMEBREW_DEV=1): the pairing PIN is fixed at\n' +
            '  000000 and the service accepts remote evaluation. It cannot be released.'
        );
    }

    if (config.placeholders.length && opts.requireReal) {
        fail(
            'catalogUrl still points at a placeholder host.\n' +
            '  Edit tizen.config.json, or set HOMEBREW_CATALOG_URL, before a release build.'
        );
    }

    return config;
}

module.exports = { load, CONFIG_PATH, ROOT, PLACEHOLDER_HOSTS };
