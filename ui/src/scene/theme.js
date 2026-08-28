// The channel theme: an intro that plays once, then a loop, forever, with
// nothing between them.
//
// The handover is the whole problem. The obvious shape — play the intro,
// listen for it to end, start the loop — cannot be gapless on any engine:
// `ended` fires on the main thread after the audio clock has already moved
// on, so the second sound starts late by however long that took. Scheduling
// the second source at `startTime + intro.duration` is better and still not
// exact, because two decodes can disagree about where a buffer ends by a
// sample or two.
//
// So there is no handover. `tools/theme-audio.js` writes both parts into one
// file, the intro first, and this plays that one buffer with `loopStart` set
// to the frame the loop begins at. The intro plays once because the playhead
// starts before `loopStart`; the loop repeats because the playhead never gets
// past `loopEnd` again. There is no second source, no second decode and no
// seam to get wrong — the engine's own resampler does the join, sample for
// sample, on the audio thread.
//
// The one number this file has to know is where the loop starts, and it is
// the frame count of the intro part as `tools/theme-audio.js` measured it.
//
// The other thing this file does not do is hand the audio to the platform.
// `decodeAudioData` is the obvious way to turn a file into samples and it is
// not trustworthy here: given a FLAC, Chromium 76 on a Samsung TV returned 77
// of its 88 blocks and stopped — 11.088s of a 12.631s file, no error, no
// warning. The loop then ran to the end of what it had, so the last bar went
// missing every time round, and it sounded exactly like a loop point chosen
// badly.
//
// So the file is plain RIFF/WAVE and the samples are read out of it here.
// That is about forty lines and it removes an entire class of failure: there
// is no codec to have a bug, no block structure to stop early at, and the
// frame count is checked against the number the file was built with rather
// than believed.

const FILE = 'theme.wav';

// wiibrew-banner-intro-part.wav: 134747 frames at 32000Hz.
//
// Seconds rather than frames, deliberately. `decodeAudioData` resamples to
// whatever rate the AudioContext runs at — 44100 or 48000 on most hardware,
// neither of them a whole multiple of 32000 — and `loopStart` is measured in
// seconds against the decoded buffer, so a time survives that conversion
// where a frame index would not.
const LOOP_START_FRAME = 134747;
const TOTAL_FRAMES = 404199;
const SOURCE_RATE = 32000;

const LOOP_START = LOOP_START_FRAME / SOURCE_RATE;
const LOOP_END = TOTAL_FRAMES / SOURCE_RATE;

// Loud enough to be part of the room, quiet enough to talk over.
const LEVEL = 0.55;

// A cut to silence clicks. Ramping is only ever heard as the absence of that.
const FADE = 0.12;

const STORAGE_KEY = 'tizen-homebrew.theme';

const AudioContextClass = window.AudioContext || window.webkitAudioContext;

/**
 * Reads the muted preference, falling back to what the page asked for.
 *
 * The two pages want opposite defaults. The television is the channel and
 * should sound like it the moment it opens; the phone is a tool held in a
 * hand, quite possibly in a room where the television is already playing the
 * same music, and starting a second copy of it unasked would be rude. A
 * person's own choice overrides either.
 *
 * Wrapped because a webview with storage disabled throws on access rather
 * than returning null, and losing the music is a better outcome than losing
 * the page.
 */
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
        // A preference that cannot be saved is not worth failing over.
    }
};

/**
 * Starts the theme.
 *
 * `onState({ playing, blocked, failed })` is called whenever any of those
 * change, so a page can label its own mute control without polling. Every
 * failure here is soft: a television with no FLAC decoder, no Web Audio or no
 * route to the file gets a silent channel, not a broken one.
 *
 * `defaultOn` is what to do before the person has expressed a preference.
 */
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
        // XHR rather than fetch: this page also runs on Chromium 63, where
        // `fetch` exists but `Response.arrayBuffer` is the only part of it
        // this needs — and XHR reports a network failure the same way on
        // every engine the app targets.
        const request = new XMLHttpRequest();
        request.open('GET', FILE, true);
        request.responseType = 'arraybuffer';
        request.onload = () => (request.status < 400
            ? resolve(request.response)
            : reject(new Error(`HTTP ${request.status}`)));
        request.onerror = () => reject(new Error('unreachable'));
        request.send();
    });

    /**
     * Turns the file's bytes into an AudioBuffer, without the platform.
     *
     * Chunks are walked rather than assuming the canonical 44-byte header —
     * the same reason `tools/theme-audio.js` walks them — and the frame count
     * that comes out is checked against the one the file was built with, so a
     * short read is an error here rather than a missing bar later.
     *
     * The buffer is created at the file's own rate. Web Audio resamples to
     * the context's rate at playback time, which keeps this function free of
     * any resampling of its own and keeps the loop points exact in seconds.
     */
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

            // Chunks are word-aligned, so an odd size is followed by a pad byte.
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
                // Int16 to the -1..1 the API wants. 32768 rather than 32767:
                // it is the actual magnitude of the negative rail, so full
                // scale maps to exactly -1 and nothing ever clips.
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

        // The end of the music, from the frame count the file was built with
        // — not from `buffer.duration`, which is whatever this engine's
        // decoder happened to produce. The two agree to half a sample in
        // Chrome. They are not guaranteed to agree anywhere else: a decoder
        // that drops its last block reports a shorter buffer, and taking that
        // as the loop end would quietly cut the final beat off every time
        // round. Asking for the real end and letting it clamp fails safe.
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

        // Stopped after the ramp, not with it, or the fade is cut off by the
        // very thing it exists to avoid.
        window.setTimeout(() => ending.stop(0), (FADE + 0.05) * 1000);

        source = null;
        report();
    };

    /**
     * Resumes a context the autoplay policy suspended.
     *
     * A browser will not let a page make noise before the person has touched
     * it, and a television generally will. Rather than detect which is which,
     * the same code covers both: try immediately, and if the context comes up
     * suspended, try again on the first thing the person does.
     */
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
        /** Resolves once the theme is playing, or with the reason it is not. */
        ready: started,

        /** True while the theme is meant to be audible. */
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
