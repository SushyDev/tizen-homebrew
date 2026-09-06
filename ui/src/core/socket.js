const RETRY_FLOOR = 250;
const RETRY_CEILING = 3000;

// Nothing here is on a clock. The socket reconnects on its own because a TV that briefly drops off
// the network should not require the phone to be reloaded — and on the television's own page this is
// also how it waits for a service that has not finished starting. There is no platform event for
// "the port is open now", but a refused connection is itself an event, so the only interval is the
// pause between attempts, which grows to a few seconds and stops the moment one is accepted.
const connect = ({ url, onMessage, onStatus }) => {
    const address = url || (import.meta.env.DEV
        ? `ws://${location.host}/socket`
        : `ws://${location.host}`);

    let socket = null;
    let attempts = 0;

    const open = () => {
        attempts += 1;
        socket = new WebSocket(address);

        socket.onopen = () => {
            attempts = 0;
            onStatus('connected');
        };

        socket.onmessage = (event) => {
            try {
                const { type, payload } = JSON.parse(event.data);
                onMessage(type, payload || {});
            } catch (e) {
                // A malformed frame is the service's problem, not a reason to
                // tear down a working connection.
            }
        };

        // A connection that was never accepted closes too, so this is the only retry path either page
        // needs. The first attempt after a working socket drops is immediate.
        socket.onclose = () => {
            onStatus('reconnecting', attempts);
            setTimeout(open, Math.min(RETRY_CEILING, RETRY_FLOOR * attempts));
        };

        socket.onerror = () => {};
    };

    open();

    const send = (type, payload = {}) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type, payload }));
        }
    };

    return { send };
};

// XHR rather than fetch, only because it reports upload progress. The bar stops short of full
// until the reply lands, since the TV then stages and installs without reporting anything.
const upload = ({ file, pin, onProgress }) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open('POST', '/install', true);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('x-homebrew-pin', pin);
    request.setRequestHeader('x-homebrew-name', file.name);

    request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 90));
    };

    request.onload = () => {
        const body = (() => {
            try {
                return JSON.parse(request.responseText);
            } catch (e) {
                return null;
            }
        })();

        if (request.status === 200 && body && body.ok) return resolve(body);

        reject(Object.assign(
            new Error((body && body.message) || `HTTP ${request.status}`),
            { code: body && body.code, remedy: (body && body.remedy) || null }
        ));
    };

    request.onerror = () => reject(new Error('The connection dropped.'));

    request.send(file);
});

export { connect, upload };
