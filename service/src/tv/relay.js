'use strict';

const sdb = require('./sdb.js');
const { ErrorCode, ProtocolError } = require('../protocol.js');

const DEFAULT_TIMEOUT = 60000;
const MAX_TIMEOUT = 600000;
const MAX_OUTPUT = 1024 * 1024;
const MAX_CONCURRENT = 4;

// Not a security boundary, but a guard against locking yourself out with no way back in.
const SELF_DESTRUCTIVE = [
    /buxton2ctl\s+set\S*\s+system\s+db\/sdk\/develop\/(ip|mode)\b/,
    /(pkgcmd|wascmd|vd_appuninstall)\b[^\n]*\b__PACKAGE_ID__\b/
];

function isSelfDestructive(command, packageId) {
    return SELF_DESTRUCTIVE.some((pattern) => {
        const source = pattern.source.replace('__PACKAGE_ID__', packageId || 'homebrew');
        return new RegExp(source).test(command);
    });
}

const SDB_ERROR_CODES = {
    sdbRefused: ErrorCode.SDB_REFUSED,
    sdbReset: ErrorCode.DEBUG_IP_WRONG,
    sdbClosed: ErrorCode.SDB_REFUSED,
    sdbTimeout: ErrorCode.SDB_TIMEOUT
};

function asProtocolError(err) {
    if (!err || err.isProtocolError) return err;
    const mapped = SDB_ERROR_CODES[err.code];
    if (mapped) return ProtocolError(mapped, err.message);
    return ProtocolError(ErrorCode.INTERNAL, err.message || String(err));
}

function Relay(options) {
    const opts = options || {};
    this.enabled = !!opts.enabled;
    this.packageId = opts.packageId || null;
    this.log = opts.log || function () {};
    this.running = new Map();
}

Relay.prototype.setEnabled = function (enabled) {
    this.enabled = !!enabled;
    this.log(`relay ${this.enabled ? 'enabled' : 'disabled'}`);
    return this.enabled;
};

Relay.prototype.exec = function (id, command, options) {
    const opts = options || {};
    const self = this;

    if (!this.enabled) {
        return Promise.reject(ProtocolError(
            ErrorCode.RELAY_DISABLED,
            'The command relay is turned off. Enable it from the Tizen Homebrew UI first.'
        ));
    }

    if (this.running.size >= MAX_CONCURRENT) {
        return Promise.reject(ProtocolError(
            ErrorCode.INTERNAL,
            `Too many commands running at once (limit ${MAX_CONCURRENT}).`
        ));
    }

    if (this.running.has(id)) {
        return Promise.reject(ProtocolError(ErrorCode.BAD_MESSAGE, `Command id ${id} is already running.`));
    }

    const trimmed = command.trim();

    if (isSelfDestructive(trimmed, this.packageId)) {
        return Promise.reject(ProtocolError(
            ErrorCode.BAD_MESSAGE,
            'Refused: that command would disable the relay or remove Tizen Homebrew, leaving no way back in without a computer.'
        ));
    }

    const timeout = Math.min(Math.max(Number(opts.timeout) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);

    this.log(`relay exec: ${trimmed}`);

    let output = '';
    let truncated = false;

    const run = sdb.withSession({}, (session) =>
        session.exec(`shell:0 ${trimmed}`, {
            timeout,
            onData: (chunk) => {
                if (truncated) return;

                if (output.length + chunk.length > MAX_OUTPUT) {
                    truncated = true;
                    chunk = chunk.slice(0, Math.max(0, MAX_OUTPUT - output.length));
                }

                output += chunk;
                if (chunk && opts.onChunk) opts.onChunk(chunk);
            }
        })
    ).then(
        (full) => {
            self.running.delete(id);
            return { output: truncated ? output : full, truncated };
        },
        (err) => {
            self.running.delete(id);
            if (err && err.code === 'sdbTimeout' && output) {
                return { output, truncated, timedOut: true };
            }
            throw asProtocolError(err);
        }
    );

    this.running.set(id, run);
    return run;
};

module.exports = { Relay, isSelfDestructive, MAX_OUTPUT, MAX_CONCURRENT, DEFAULT_TIMEOUT, MAX_TIMEOUT };
