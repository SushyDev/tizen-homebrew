'use strict';

// Every inbound message is validated: the reference implementation's bare integer enum made a
// missing `break` in a switch silently destructive.

const Inbound = {
    HELLO: 'hello',                 // { pin }
    GET_STATE: 'getState',          // -
    GET_CATALOG: 'getCatalog',      // { refresh? }
    CHECK_UPDATES: 'checkUpdates',  // { id? }
    INSTALL: 'install',             // { source: 'catalog'|'github'|'url'|'file', ref }
    LIST_DIR: 'listDir',            // { path }
    SUBMIT_ACCESS_INFO: 'submitAccessInfo', // { accessToken, userId, email }
    FORGET_CERTS: 'forgetCerts',    // -
    SET_RELAY: 'setRelay',          // { enabled, persist? }
    RELAY_EXEC: 'relayExec'         // { id, command, timeout? }
};

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

const Phase = {
    PROBING: 'probing',
    FETCHING: 'fetching',
    RESIGNING: 'resigning',
    STAGING: 'staging',
    INSTALLING: 'installing'
};

// Stable identifiers the UI maps to translated strings; every code the service throws belongs here.
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

    if (msg.type === Inbound.CHECK_UPDATES && 'id' in payload && payload.id !== null &&
        typeof payload.id !== 'string') {
        throw ProtocolError(ErrorCode.BAD_MESSAGE, 'checkUpdates takes the id of one app, or nothing at all.');
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
