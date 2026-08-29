'use strict';

// HTTP answers single questions; the socket handles everything that unfolds. `protocol.js` fixes the shapes.

const { readdirSync, statSync } = require('fs');
const { join } = require('path');

const WebSocket = require('ws');

const preview = require('./install/preview.js');
const { took, host } = require('./obs/units.js');

const CLOSED_BECAUSE = {
    1000: 'normally',
    1001: 'the page went away',
    1005: 'no reason given',
    1006: 'abnormally — the network dropped',
    1011: 'the service faulted',
    1012: 'the service is restarting'
};

const attach = ({ server, store, authorise, installer, catalog, updates, relay, refreshDevice, config, protocol, log }) => {
    const { Inbound, Outbound, ErrorCode, ProtocolError } = protocol;

    const say = log ? log.on('sock') : null;
    const auth = log ? log.on('auth') : null;

    const wsServer = new WebSocket.Server({ server });

    let connected = 0;

    wsServer.on('connection', (socket, request) => {
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
            // A coded error is a refusal this service meant to make; only a surprise gets a trace.
            const expected = Boolean(error && error.code);

            if (say) {
                say[expected ? 'warn' : 'err'](`${client} refused: ` +
                    `${(error && error.code) || 'internal'} — ${(error && error.message) || 'unexpected failure'}`);
            }

            if (!expected) console.error(error && error.stack ? error.stack : error);

            send(Outbound.ERROR, {
                code: expected ? error.code : ErrorCode.INTERNAL,
                message: (error && error.message) || 'Unexpected failure.',
                // Only on failures verdicts.js recognised: what to do, which the UI cannot know.
                remedy: (error && error.remedy) || null,
                fatal: false
            });
        };

        const sendDeviceState = async () => {
            const state = await refreshDevice();
            send(Outbound.STATE, { ...state, hasCertificates: config.hasCertificates() });
        };

        const greet = async ({ pin }) => {
            const verdict = authorise(pin);

            if (!verdict.ok) {
                if (auth) auth.warn(`${client} ${verdict.code === ErrorCode.LOCKED_OUT ? 'is locked out' : 'gave the wrong PIN'}`);

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

            store.update({ catalog: result.entries, catalogStale: result.stale });

            // Marked from the kept listing rather than by asking the set, so the list draws now.
            send(Outbound.CATALOG, { ...result, entries: await updates.mark(result.entries) });
        };

        const checkUpdates = async ({ id }) => {
            const entries = store.select('catalog') || [];

            send(Outbound.CATALOG, {
                entries: await updates.check(entries, { id: id || null }),
                stale: Boolean(store.select('catalogStale')),
                source: 'cache'
            });
        };

        const describe = ({ source, ref }) => `${source} ${ref}`;

        const runInstall = async ({ source, ref }) => {
            if (say) say.info(`${client} asked to install ${describe({ source, ref })}`);

            try {
                const outcome = await installer.install(
                    { source, reference: ref },
                    (phase, detail, extra) => send(Outbound.PROGRESS, {
                        phase,
                        detail: detail || null,
                        identity: (extra && extra.identity) || null
                    })
                );

                updates.changed();

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

                    if (!stats.isDirectory() && !isPackage(name)) return found;

                    // Opened far enough to learn what it calls itself; a filename is not that.
                    return found.concat({
                        name,
                        path: full,
                        isDirectory: stats.isDirectory(),
                        size: stats.isDirectory() ? null : stats.size,
                        identity: stats.isDirectory() ? null : preview.describeFile(full)
                    });
                } catch (e) {
                    return found; // Unreadable entries are simply not offered.
                }
            }, [{ name: '..', path: root === '/media' ? '/media' : join(root, '..'), isDirectory: true }]);

            send(Outbound.DIR, entries);
        };

        const setRelay = ({ enabled, persist }) => {
            if (say) say.warn(`${client} turned the command relay ${enabled ? 'on' : 'off'}${persist ? ', and stored that' : ''}`);

            relay.setEnabled(enabled);

            // A second opt-in, so one job does not leave shell access open for good.
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

        // Minting needs a Samsung account, so the pair is made on a computer and sent here.
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
            [Inbound.CHECK_UPDATES]: checkUpdates,
            [Inbound.INSTALL]: runInstall,
            [Inbound.LIST_DIR]: listDirectory,
            [Inbound.SET_RELAY]: setRelay,
            [Inbound.RELAY_EXEC]: runRelayCommand,
            [Inbound.SUBMIT_ACCESS_INFO]: createCertificates,
            [Inbound.FORGET_CERTS]: forgetCertificates
        };

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

            if (!paired && message.type !== Inbound.HELLO) {
                return sendFailure(ProtocolError(ErrorCode.UNAUTHORIZED, 'Enter the PIN shown on the TV first.'));
            }

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
