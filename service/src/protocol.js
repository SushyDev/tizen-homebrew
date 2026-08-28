'use strict';

// Wire protocol between the phone UI and the on-TV service.
//
// The reference implementation used a bare integer enum (TizenBrewInstaller
// utils/wsCommunication.js) with no payload validation, which made a missing
// `break` in the service's switch silently destructive. Events are strings
// here and every inbound message is validated before it reaches a handler.

// Client -> service.
const Inbound = {
    HELLO: 'hello',                 // { pin }
    GET_STATE: 'getState',          // -
    GET_CATALOG: 'getCatalog',      // { refresh? }
    INSTALL: 'install',             // { source: 'catalog'|'github'|'url'|'file', ref }
    LIST_DIR: 'listDir',            // { path }
    SUBMIT_ACCESS_INFO: 'submitAccessInfo', // { accessToken, userId, email }
    FORGET_CERTS: 'forgetCerts',    // -
    SET_RELAY: 'setRelay',          // { enabled, persist? }
    RELAY_EXEC: 'relayExec'         // { id, command, timeout? }
};

// Service -> client.
const Outbound = {
    HELLO: 'hello',                 // { ok, needsPin }
    STATE: 'state',                 // DeviceState
    CATALOG: 'catalog',             // [CatalogEntry]
    PROGRESS: 'progress',           // { phase, detail? }
    DONE: 'done',                   // { packageId, appId }
    ERROR: 'error',                 // { code, message, fatal }
    DIR: 'dir',                     // [{ name, path, isDirectory }]
    NEEDS_CERTS: 'needsCerts',      // { ip }
    RELAY_STATE: 'relayState',      // { enabled }
    RELAY_DATA: 'relayData',        // { id, chunk }
    RELAY_END: 'relayEnd'           // { id, output, truncated? }
};

// Install lifecycle. The UI renders these in order; each is entered exactly
// once per attempt so a stuck install is visible rather than silent.
const Phase = {
    PROBING: 'probing',
    FETCHING: 'fetching',
    RESIGNING: 'resigning',
    STAGING: 'staging',
    INSTALLING: 'installing'
};

// Error codes are stable identifiers; the UI maps them to translated strings.
const ErrorCode = {
    BAD_MESSAGE: 'badMessage',
    UNAUTHORIZED: 'unauthorized',
    DEBUG_MODE_OFF: 'debugModeOff',
    DEBUG_IP_WRONG: 'debugIpWrong',
    SDB_REFUSED: 'sdbRefused',
    SDB_TIMEOUT: 'sdbTimeout',
    NOT_FOUND: 'notFound',
    DOWNLOAD_FAILED: 'downloadFailed',
    BAD_PACKAGE: 'badPackage',
    CERTS_MISSING: 'certsMissing',
    RESIGN_FAILED: 'resignFailed',
    INSTALL_FAILED: 'installFailed',
    CERT_REJECTED: 'certRejected',
    RELAY_DISABLED: 'relayDisabled',
    LOCKED_OUT: 'lockedOut',
    INTERNAL: 'internal'
};

function ProtocolError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    e.isProtocolError = true;
    return e;
}

const INSTALL_SOURCES = ['catalog', 'github', 'url', 'file'];

// Returns { type, payload } or throws a ProtocolError. Validation is
// deliberately strict: an unrecognised type is an error, not a fallthrough.
function parse(raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (e) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Message was not valid JSON.');
    }

    if (!msg || typeof msg.type !== 'string') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Message had no type.');
    }

    let known = false;
    for (const k in Inbound) {
        if (Inbound[k] === msg.type) { known = true; break; }
    }
    if (!known) {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, `Unknown message type: ${msg.type}`);
    }

    const payload = msg.payload || {};

    if (msg.type === Inbound.INSTALL) {
        if (INSTALL_SOURCES.indexOf(payload.source) === -1) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, `Unknown install source: ${payload.source}`);
        }
        if (typeof payload.ref !== 'string' || !payload.ref) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'Install ref must be a non-empty string.');
        }
    }

    if (msg.type === Inbound.LIST_DIR && typeof payload.path !== 'string') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'listDir requires a path.');
    }

    if (msg.type === Inbound.RELAY_EXEC) {
        if (typeof payload.id !== 'string' || !payload.id) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'relayExec requires an id to correlate output with.');
        }
        if (typeof payload.command !== 'string' || !payload.command.trim()) {
            throw ProtocolError(ErrorCode.BAD_MESSAGE, 'relayExec requires a command.');
        }
    }

    if (msg.type === Inbound.SET_RELAY && typeof payload.enabled !== 'boolean') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'setRelay requires enabled to be a boolean.');
    }

    return { type: msg.type, payload };
}

function encode(type, payload) {
    return JSON.stringify({ type, payload: payload === undefined ? null : payload });
}

module.exports = {
    Inbound,
    Outbound,
    Phase,
    ErrorCode,
    ProtocolError,
    parse,
    encode
};
