const RECONNECT_DELAY = 1500;

// The socket reconnects on its own, because a TV that briefly drops off the network should not
// require the phone to be reloaded.
const connect = ({ onMessage, onStatus }) => {
    const url = import.meta.env.DEV
        ? `ws://${location.host}/socket`
        : `ws://${location.host}`;

    let socket = null;

    const open = () => {
        socket = new WebSocket(url);

        socket.onopen = () => onStatus('connected');

        socket.onmessage = (event) => {
            try {
                const { type, payload } = JSON.parse(event.data);
                onMessage(type, payload || {});
            } catch (e) {
                // A malformed frame is the service's problem, not a reason to
                // tear down a working connection.
            }
        };

        socket.onclose = () => {
            onStatus('reconnecting');
            setTimeout(open, RECONNECT_DELAY);
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
