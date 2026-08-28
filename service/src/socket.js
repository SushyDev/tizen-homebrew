'use strict';

// The WebSocket half of Tizen Homebrew.
//
// HTTP handles the things that are a single question and answer — what build
// is this, install these bytes, restart. The socket handles everything that
// unfolds: an install reporting each phase as it happens, a relayed command
// streaming output as it arrives.
//
// The message shapes here are fixed by `protocol.js` and must not drift.
// `tools/push.js` and the phone UI both speak this, and a change that looks
// harmless from inside breaks them silently from outside.

const { readdirSync, statSync } = require('fs');
const { join } = require('path');

const WebSocket = require('ws');

const { took, host } = require('./obs/units.js');

// What a close code means, for the one line a person reads after a phone
// disappears. RFC 6455's registry, minus the codes a browser never sends.
const CLOSED_BECAUSE = {
    1000: 'normally',
    1001: 'the page went away',
    1005: 'no reason given',
    1006: 'abnormally — the network dropped',
    1011: 'the service faulted',
    1012: 'the service is restarting'
};

/**
 * Attaches the socket server to an already-listening HTTP server.
 *
 * Everything it needs is handed in: this file owns no state of its own beyond
 * whether a given connection has paired.
 */
const attach = ({ server, store, authorise, installer, catalog, relay, refreshDevice, config, protocol, log }) => {
    const { Inbound, Outbound, ErrorCode, ProtocolError } = protocol;

    const say = log ? log.on('sock') : null;
    const auth = log ? log.on('auth') : null;

    const wsServer = new WebSocket.Server({ server });

    // How many phones are on. Reported with every arrival and departure
    // because "is anything still connected" is the question that makes the
    // rest of the log make sense.
    let connected = 0;

    wsServer.on('connection', (socket, request) => {
        // The one piece of per-connection state, and it only ever goes false
        // to true.
        let paired = false;

        const client = host((request && request.socket && request.socket.remoteAddress) ||
            (socket._socket && socket._socket.remoteAddress));
        const openedAt = Date.now();

        connected += 1;
        if (say) say.info(`${client} connected (${connected} ${connected === 1 ? 'client' : 'clients'})`);

        socket.on('close', (code, reason) => {
            connected = Math.max(0, connected - 1);

            if (!say) return;

            const why = CLOSED_BECAUSE[code] || (reason ? String(reason) : `code ${code}`);
            say.info(`${client} disconnected ${why} after ${took(Date.now() - openedAt)} ` +
                `(${connected} ${connected === 1 ? 'client' : 'clients'})`);
        });

        const send = (type, payload) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(protocol.encode(type, payload));
        };

        const sendFailure = (error) => {
            // An error carrying a code is a refusal this service meant to make
            // — a bad URL, a missing file, a wrong PIN. Only a *codeless*
            // error is a surprise, and only surprises deserve a stack trace.
            const expected = Boolean(error && error.code);

            if (say) {
                say[expected ? 'warn' : 'err'](`${client} refused: ` +
                    `${(error && error.code) || 'internal'} — ${(error && error.message) || 'unexpected failure'}`);
            }

            if (!expected) console.error(error && error.stack ? error.stack : error);

            send(Outbound.ERROR, {
                code: expected ? error.code : ErrorCode.INTERNAL,
                message: (error && error.message) || 'Unexpected failure.',
                // Present only on failures install/verdicts.js recognised. The
                // UI's own table says what a code means; this says what to do
                // about it, which it cannot know because it names the package.
                remedy: (error && error.remedy) || null,
                fatal: false
            });
        };

        const sendDeviceState = async () => {
            const state = await refreshDevice();
            send(Outbound.STATE, { ...state, hasCertificates: config.hasCertificates() });
        };

        // --- the handlers, one per message the protocol allows ------------

        const greet = async ({ pin }) => {
            const verdict = authorise(pin);

            if (!verdict.ok) {
                if (auth) auth.warn(`${client} ${verdict.code === ErrorCode.LOCKED_OUT ? 'is locked out' : 'gave the wrong PIN'}`);

                // A lockout is worth saying out loud; a plain wrong PIN is
                // just "try again", and the UI already knows how to ask.
                if (verdict.code === ErrorCode.LOCKED_OUT) return sendFailure(ProtocolError(verdict.code, verdict.message));
                return send(Outbound.HELLO, { ok: false, needsPin: true });
            }

            paired = true;
            if (auth) auth.ok(`${client} paired`);
            send(Outbound.HELLO, { ok: true, needsPin: false });
            send(Outbound.RELAY_STATE, { enabled: relay.enabled });

            await sendDeviceState();
        };

        const listCatalog = async ({ refresh }) => {
            const result = await catalog.fetch({ refresh: !!refresh });
            store.update({ catalog: result.entries });
            send(Outbound.CATALOG, result);
        };

        // Which app, from where, on whose behalf. The pipeline reports every
        // step after this one; this is the line that says who asked.
        const describe = ({ source, ref }) => `${source} ${ref}`;

        const runInstall = async ({ source, ref }) => {
            if (say) say.info(`${client} asked to install ${describe({ source, ref })}`);

            try {
                const outcome = await installer.install(
                    { source, reference: ref },
                    (phase, detail) => send(Outbound.PROGRESS, { phase, detail: detail || null })
                );

                send(Outbound.DONE, outcome);
            } catch (error) {
                if (error.code === ErrorCode.CERTS_MISSING) {
                    const state = store.select('device');
                    send(Outbound.NEEDS_CERTS, { ip: state ? state.deviceIp : null });
                }
                sendFailure(error);
            }
        };

        const listDirectory = ({ path }) => {
            const root = path || '/media';

            const readable = (() => {
                try {
                    return readdirSync(root);
                } catch (e) {
                    return null;
                }
            })();

            if (!readable) return sendFailure(ProtocolError(ErrorCode.NOT_FOUND, `Cannot read ${root}.`));

            const isPackage = (name) => /\.(wgt|tpk)$/i.test(name);

            const entries = readable.reduce((found, name) => {
                const full = join(root, name);

                try {
                    const stats = statSync(full);
                    // Only directories to descend into, and things worth installing.
                    return stats.isDirectory() || isPackage(name)
                        ? found.concat({ name, path: full, isDirectory: stats.isDirectory() })
                        : found;
                } catch (e) {
                    return found; // Unreadable entries are simply not offered.
                }
            }, [{ name: '..', path: root === '/media' ? '/media' : join(root, '..'), isDirectory: true }]);

            send(Outbound.DIR, entries);
        };

        const setRelay = ({ enabled, persist }) => {
            if (say) say.warn(`${client} turned the command relay ${enabled ? 'on' : 'off'}${persist ? ', and stored that' : ''}`);

            relay.setEnabled(enabled);

            // Persisting is a second, separate opt-in, so turning the relay on
            // for one job does not quietly leave shell access open for good.
            if (persist) config.update({ relayEnabled: relay.enabled });

            send(Outbound.RELAY_STATE, { enabled: relay.enabled });
        };

        const runRelayCommand = async ({ id, command, timeout }) => {
            try {
                const result = await relay.exec(id, command, {
                    timeout,
                    onChunk: (chunk) => send(Outbound.RELAY_DATA, { id, chunk })
                });

                send(Outbound.RELAY_END, {
                    id,
                    output: result.output,
                    truncated: result.truncated,
                    timedOut: !!result.timedOut
                });
            } catch (error) {
                sendFailure(error);
            }
        };

        // Minting a pair needs a Samsung account, and signing into one from a
        // television remote is not a thing anybody should be asked to do. So
        // the pair is made on a computer, once, and sent here — see
        // `npm run certs` and POST /certificates. Re-signing itself is on the
        // TV, which is the half that matters.
        const createCertificates = () => sendFailure(ProtocolError(
            ErrorCode.RESIGN_FAILED,
            'Certificates are minted on a computer and sent to this TV with `npm run certs`. ' +
            'Signing into a Samsung account from here is not supported.'
        ));

        const forgetCertificates = async () => {
            config.forgetCertificates();
            await sendDeviceState();
        };

        const handlers = {
            [Inbound.HELLO]: greet,
            [Inbound.GET_STATE]: sendDeviceState,
            [Inbound.GET_CATALOG]: listCatalog,
            [Inbound.INSTALL]: runInstall,
            [Inbound.LIST_DIR]: listDirectory,
            [Inbound.SET_RELAY]: setRelay,
            [Inbound.RELAY_EXEC]: runRelayCommand,
            [Inbound.SUBMIT_ACCESS_INFO]: createCertificates,
            [Inbound.FORGET_CERTS]: forgetCertificates
        };

        // --- the loop -----------------------------------------------------

        send(Outbound.HELLO, { ok: false, needsPin: true });

        socket.on('message', async (raw) => {
            const message = (() => {
                try {
                    return protocol.parse(raw);
                } catch (error) {
                    sendFailure(error);
                    return null;
                }
            })();

            if (!message) return;

            // Everything except the handshake requires a paired client.
            if (!paired && message.type !== Inbound.HELLO) {
                return sendFailure(ProtocolError(ErrorCode.UNAUTHORIZED, 'Enter the PIN shown on the TV first.'));
            }

            // Every message a phone sends, in the order it sent them. This is
            // the record that makes a report of the form "it broke when I
            // pressed install" answerable after the fact.
            if (say && message.type !== Inbound.HELLO) say.info(`${client} ${message.type}`);

            try {
                await handlers[message.type](message.payload);
            } catch (error) {
                sendFailure(error);
            }
        });

        socket.on('error', (error) => {
            if (say) say.err(`${client} socket error: ${error.message}`);
        });
    });

    return wsServer;
};

module.exports = { attach };
