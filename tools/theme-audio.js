'use strict';

// Builds the channel theme from the Homebrew Channel's banner sound.
//
//   node tools/theme-audio.js <path-to-hbc-checkout>
//
// The Wii banner ships its music as two files — an intro that plays once and
// a loop that plays forever after it — and the Wii's own BNS container simply
// stores them back to back with a loop point between. This does the same
// thing for a browser: one file, both parts, and the sample offset where the
// loop begins written out beside it.
//
// Why one file rather than two: a browser can only hand a seamless loop back
// if the loop lives inside a single decoded buffer. Two buffers means two
// decodes, two clock domains and an audible seam at the handover no matter
// how carefully the second is scheduled. One buffer with `loopStart` set is
// sample-exact by construction. See ui/src/scene/theme.js.
//
// Why uncompressed: because the television's decoder cannot be trusted with
// anything else. This shipped as FLAC first — lossless, a third smaller, and
// correct in every browser it was tested in. On a Samsung TV, Chromium 76's
// FLAC decoder returned 77 of the file's 88 blocks and stopped: 11.088s of a
// 12.631s file, with no error anywhere. The missing 1.5s is the last bar, so
// every time round the loop the music lost its final beat.
//
// A codec that truncates is indistinguishable from a badly chosen loop point,
// which is why ui/src/scene/theme.js parses this file itself rather than
// handing it to decodeAudioData. That only works if the container is one a
// hundred lines of JavaScript can read, so this writes plain RIFF/WAVE: no
// codec, no block structure, nothing to truncate at, and the samples arrive
// exactly as the composer left them.
//
// It costs about 600KB over the FLAC. That is the price of the loop being
// right on the one device that has to run it.

const { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } = require('fs');
const { join, dirname } = require('path');

const ui = require('./ui.js');

const OUT = join(__dirname, '..', 'ui', 'public', 'theme.wav');

const PARTS = [
    'channel/banner/sound/wiibrew-banner-intro-part.wav',
    'channel/banner/sound/wiibrew-banner-loop-part.wav'
];

/**
 * Reads a RIFF/WAVE file into its format and its samples.
 *
 * Chunks are walked rather than assuming the canonical 44-byte header: a WAV
 * may legally carry LIST or fact chunks before the data, and reading at a
 * fixed offset would silently return metadata as audio.
 */
function readWave(path) {
    const buffer = readFileSync(path);

    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`${path} is not a RIFF/WAVE file`);
    }

    let offset = 12;
    let format = null;
    let samples = null;

    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);

        if (id === 'fmt ') format = buffer.slice(offset + 8, offset + 8 + size);
        if (id === 'data') samples = buffer.slice(offset + 8, offset + 8 + size);

        // Chunks are word-aligned, so an odd size is followed by a pad byte.
        offset += 8 + size + (size & 1);
    }

    if (!format || !samples) throw new Error(`${path} has no fmt / data chunk`);

    return {
        encoding: format.readUInt16LE(0),
        channels: format.readUInt16LE(2),
        rate: format.readUInt32LE(4),
        bits: format.readUInt16LE(14),
        samples
    };
}

/** Writes 16-bit PCM back out as a canonical WAVE file. */
function writeWave(path, { channels, rate, bits, samples }) {
    const blockAlign = channels * (bits / 8);
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + samples.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);        // PCM fmt chunk length
    header.writeUInt16LE(1, 20);         // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bits, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples.length, 40);

    writeFileSync(path, Buffer.concat([header, samples]));
}

function main() {
    const source = process.argv[2] || join(__dirname, '..', 'hbc');

    const paths = PARTS.map((part) => join(source, part));
    const missing = paths.filter((path) => !existsSync(path));

    if (missing.length > 0) {
        const error = new Error(
            `The Homebrew Channel's banner sound is not at ${source}.\n\n` +
            missing.map((path) => `  missing: ${path}`).join('\n') + '\n\n' +
            '  Pass the path to an hbc checkout:\n' +
            '    node tools/theme-audio.js ../hbc'
        );
        error.isFriendly = true;
        throw error;
    }

    ui.heading('theme audio', 'the Homebrew Channel banner, as one looping file');

    const [intro, loop] = paths.map(readWave);

    // The two parts are played back to back as one stream, so any difference
    // in rate or channel count would change pitch or width at the loop point.
    const differs = ['encoding', 'channels', 'rate', 'bits'].filter((key) => intro[key] !== loop[key]);
    if (differs.length > 0) throw new Error(`The two parts disagree on ${differs.join(', ')}`);
    if (intro.encoding !== 1 || intro.bits !== 16) throw new Error('Expected 16-bit PCM parts');

    const frame = intro.channels * (intro.bits / 8);
    const loopStart = intro.samples.length / frame;
    const total = (intro.samples.length + loop.samples.length) / frame;

    ui.info('intro', `${loopStart} frames · ${(loopStart / intro.rate).toFixed(3)}s`);
    ui.info('loop', `${total - loopStart} frames · ${((total - loopStart) / intro.rate).toFixed(3)}s`);
    ui.info('format', `${intro.channels}ch · ${intro.rate}Hz · ${intro.bits}-bit`);

    mkdirSync(dirname(OUT), { recursive: true });

    writeWave(OUT, { ...intro, samples: Buffer.concat([intro.samples, loop.samples]) });

    // The FLAC this replaced, if it is still lying around from an older
    // build. Left in public/ it would be copied into every package for ever.
    rmSync(join(dirname(OUT), 'theme.flac'), { force: true });

    const size = readFileSync(OUT).length;

    ui.blank();
    ui.ok('theme.wav', `${ui.bytes(size)} · loop from frame ${loopStart} of ${total}`);
    ui.blank();
    ui.note(ui.style.dim('  ui/src/scene/theme.js must agree:'));
    ui.note(ui.style.dim(`    LOOP_START_FRAME = ${loopStart}`));
    ui.note(ui.style.dim(`    TOTAL_FRAMES     = ${total}`));
    ui.note(ui.style.dim(`    SOURCE_RATE      = ${intro.rate}`));
    ui.blank();
}

try {
    main();
} catch (error) {
    ui.crash(error);
}
