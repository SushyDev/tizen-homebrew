'use strict';

const { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } = require('fs');
const { join, dirname } = require('path');

const ui = require('./ui.js');

// Builds the channel theme from the Homebrew Channel's banner sound: intro and loop written into
// one file with the loop's sample offset beside it, because a browser can only loop seamlessly
// inside a single decoded buffer.
//
// Plain RIFF/WAVE rather than FLAC: Chromium 76 on a Samsung TV returned 77 of a FLAC's 88 blocks
// with no error, so every time round the loop the music lost its final beat. It costs about 600KB.

const OUT = join(__dirname, '..', 'ui', 'public', 'theme.wav');

const PARTS = [
    'channel/banner/sound/wiibrew-banner-intro-part.wav',
    'channel/banner/sound/wiibrew-banner-loop-part.wav'
];

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
