// Intro and loop live in one file, played as one buffer with `loopStart` set to the frame the loop begins at,
// so there is no handover to get wrong.
//
// The WAVE is parsed here rather than by `decodeAudioData`, which returned 77 of a FLAC's 88 blocks on a
// Samsung TV and dropped the last bar every time round.

const FILE = 'theme.wav';

// Seconds rather than frames: `decodeAudioData` resamples to the context's rate, and `loopStart` is measured
// against the decoded buffer.
const LOOP_START_FRAME = 134747;
const TOTAL_FRAMES = 404199;
const SOURCE_RATE = 32000;

const LOOP_START = LOOP_START_FRAME / SOURCE_RATE;
const LOOP_END = TOTAL_FRAMES / SOURCE_RATE;

const LEVEL = 0.55;

const FADE = 0.12;

const STORAGE_KEY = 'tizen-homebrew.theme';

const AudioContextClass = window.AudioContext || window.webkitAudioContext;

// The television wants the channel audible on open and the phone does not, so the default is the page's; a
// person's own choice overrides it. Wrapped because storage can throw.
const remembered = (fallback) => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === null ? fallback : stored === 'on';
    } catch (e) {
        return fallback;
    }
};

const remember = (on) => {
    try {
        window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (e) {
        // Not worth failing over.
    }
};

const theme = ({ onState = () => {}, defaultOn = true } = {}) => {
    let context = null;
    let source = null;
    let gain = null;
    let buffer = null;
    let wanted = remembered(defaultOn);
    let failed = false;

    const report = () => onState({
        playing: !!source && wanted && !failed,
        blocked: !!context && context.state === 'suspended',
        failed
    });

    const fetchBuffer = () => new Promise((resolve, reject) => {
        // XHR rather than fetch, which Chromium 63 only half implements.
        const request = new XMLHttpRequest();
        request.open('GET', FILE, true);
        request.responseType = 'arraybuffer';
        request.onload = () => (request.status < 400
            ? resolve(request.response)
            : reject(new Error(`HTTP ${request.status}`)));
        request.onerror = () => reject(new Error('unreachable'));
        request.send();
    });

    // The frame count is checked against the one the file was built with, so a short read is an error here
    // rather than a missing bar later.
    const readWave = (bytes) => {
        const view = new DataView(bytes);
        const ascii = (at) => String.fromCharCode(
            view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

        if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

        let offset = 12;
        let format = null;
        let data = null;

        while (offset + 8 <= view.byteLength) {
            const id = ascii(offset);
            const size = view.getUint32(offset + 4, true);

            if (id === 'fmt ') format = offset + 8;
            if (id === 'data') data = { at: offset + 8, size };

            offset += 8 + size + (size & 1);
        }

        if (format === null || data === null) throw new Error('no fmt / data chunk');

        const encoding = view.getUint16(format, true);
        const channels = view.getUint16(format + 2, true);
        const rate = view.getUint32(format + 4, true);
        const bits = view.getUint16(format + 14, true);

        if (encoding !== 1 || bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit type ${encoding}`);

        const frames = data.size / (channels * 2);

        if (frames !== TOTAL_FRAMES) {
            throw new Error(`expected ${TOTAL_FRAMES} frames, the file carries ${frames}`);
        }

        const target = context.createBuffer(channels, frames, rate);

        for (let channel = 0; channel < channels; channel++) {
            const out = target.getChannelData(channel);
            let at = data.at + channel * 2;

            for (let i = 0; i < frames; i++) {
                // 32768 rather than 32767, so full scale maps to exactly -1 and nothing clips.
                out[i] = view.getInt16(at, true) / 32768;
                at += channels * 2;
            }
        }

        return target;
    };

    const play = () => {
        if (source || !buffer || !wanted) return;

        source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = LOOP_START;

        // From the frame count the file was built with, not `buffer.duration`: a decoder that drops its last
        // block would cut the final beat off every time round.
        source.loopEnd = Math.min(LOOP_END, buffer.duration);

        source.connect(gain);
        source.start(0);

        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.gain.linearRampToValueAtTime(LEVEL, context.currentTime + FADE);

        report();
    };

    const stop = () => {
        if (!source) return;

        const ending = source;
        const at = context.currentTime;

        gain.gain.cancelScheduledValues(at);
        gain.gain.setValueAtTime(gain.gain.value, at);
        gain.gain.linearRampToValueAtTime(0, at + FADE);

        // Stopped after the ramp, or the fade is cut off by the thing it exists to avoid.
        window.setTimeout(() => ending.stop(0), (FADE + 0.05) * 1000);

        source = null;
        report();
    };

        const unblock = () => {
        if (!context || context.state !== 'suspended') return;

        context.resume().then(() => {
            play();
            report();
        }, () => {});
    };

    const armed = ['keydown', 'pointerdown', 'touchstart', 'click'];
    const onGesture = () => unblock();

    const fail = (reason) => {
        failed = true;
        report();
        return reason;
    };

    const started = (async () => {
        if (!AudioContextClass) return fail(new Error('no Web Audio'));

        context = new AudioContextClass();
        gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(context.destination);

        armed.forEach((name) => document.addEventListener(name, onGesture, true));

        try {
            buffer = readWave(await fetchBuffer());
        } catch (cause) {
            return fail(cause instanceof Error ? cause : new Error('could not read the theme'));
        }

        play();
        unblock();
        report();

        return null;
    })();

    return {
        ready: started,

        get on() { return wanted; },

        toggle() {
            wanted = !wanted;
            remember(wanted);

            if (wanted) {
                play();
                unblock();
            } else {
                stop();
            }

            report();
            return wanted;
        },

        stop() {
            stop();
            armed.forEach((name) => document.removeEventListener(name, onGesture, true));
            if (context) context.close();
        }
    };
};

export { theme };
