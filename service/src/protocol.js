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
    CATALOG: 'catalog',             // { entries: [CatalogEntry], stale, source }
    PROGRESS: 'progress',           // { phase, detail?, identity? }
    DONE: 'done',                   // { packageId, appId }
    ERROR: 'error',                 // { code, message, remedy?, fatal }
    DIR: 'dir',                     // [{ name, path, isDirectory, size?, identity? }]
    NEEDS_CERTS: 'needsCerts',      // { ip }
    RELAY_STATE: 'relayState',      // { enabled }
    RELAY_DATA: 'relayData',        // { id, chunk }
    RELAY_END: 'relayEnd'           // { id, output, truncated? }
};

// A catalogue may arrive twice for one request. The list itself is sent the
// moment it is in hand; where the television is holding apps the catalogue
// also lists, a second one follows with `installed` and `update` marked on
// those rows — see install/updates.js, which spends a request per installed
// app to learn it and must not hold up the first send to do it.

// An `identity` — on a progress message and on the packages in a directory
// listing — is what `install/preview.js` read out of the archive itself:
// `{ packageId, appId, name, version, isWgt, icon }`, where `icon` is the
// application's own icon as a data URI. It is always optional. A package
// whose manifest cannot be read still installs; it just arrives on screen as
// the filename it came in as.

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
//
// Every code the service can throw belongs here, including the ones only the
// install sequence produces. `sdbUnreachable` did not, for a while: pipeline.js
// threw it, the UI had a string ready for it, and the one list that was
// supposed to be the register of them all did not know it existed.
//
// The install verdicts below the line are decided in one place —
// install/verdicts.js — which is also where the sentence explaining each one
// to a person lives. This end of it is only the name.
const ErrorCode = {
    BAD_MESSAGE: 'badMessage',
    UNAUTHORIZED: 'unauthorized',
    DEBUG_MODE_OFF: 'debugModeOff',
    DEBUG_IP_WRONG: 'debugIpWrong',
    SDB_REFUSED: 'sdbRefused',
    SDB_TIMEOUT: 'sdbTimeout',
    SDB_UNREACHABLE: 'sdbUnreachable',
    NOT_FOUND: 'notFound',
    DOWNLOAD_FAILED: 'downloadFailed',
    BAD_PACKAGE: 'badPackage',
    CERTS_MISSING: 'certsMissing',
    RESIGN_FAILED: 'resignFailed',
    RELAY_DISABLED: 'relayDisabled',
    LOCKED_OUT: 'lockedOut',
    INTERNAL: 'internal',

    // What a television says about a package it will not install.
    INSTALL_FAILED: 'installFailed',
    CERT_REJECTED: 'certRejected',
    AUTHOR_MISMATCH: 'authorMismatch',
    CERT_CHAIN_INVALID: 'certChainInvalid',
    SECURITY_ERROR: 'securityError',
    PRIVILEGE_TOO_HIGH: 'privilegeTooHigh'
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
