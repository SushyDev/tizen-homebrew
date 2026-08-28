'use strict';

// A real .wgt, built here rather than found on disk.
//
// The pipeline test needs a genuine Tizen package to run against: the whole
// point of it is that `install/manifest.js` reads an identity out of a real
// zip rather than out of a mock. It used to load `release/tizenhomebrew.wgt`,
// which is a build artifact — gitignored, absent from every clean checkout,
// and produced by a step that runs *after* `npm test` in CI. So the test
// either crashed with ENOENT or silently depended on whatever happened to be
// left in the working tree from an earlier build.
//
// This builds the package instead, from the application's own config.xml. The
// file it produces is a valid zip that `identify()` reads exactly as it reads
// a signed one — and because the manifest is the real one, the id the test
// asserts on is the id the app actually installs under. Change the package id
// in config.xml and this test is what tells you.

const { readFileSync } = require('fs');
const { join } = require('path');

// The standard CRC-32 (IEEE 802.3), which is what a zip entry carries. Node
// has `zlib.crc32`, but only from 20.15 — and this repo supports 20.0.
const TABLE = (() => {
    const table = new Int32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }

    return table;
})();

const crc32 = (buffer) => {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) crc = TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
};

/**
 * Packs one file into a zip, stored rather than deflated.
 *
 * Stored is what a .wgt uses for small manifests anyway, and it keeps this
 * readable: header, bytes, central directory, end record, in that order and
 * nothing else.
 */
const zip = (name, contents) => {
    const filename = Buffer.from(name, 'utf8');
    const sum = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(filename.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 10);         // stored
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28);

    const centralAt = local.length + filename.length + contents.length;
    const centralSize = central.length + filename.length;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);     // end of central directory
    end.writeUInt16LE(1, 8);              // entries on this disk
    end.writeUInt16LE(1, 10);             // entries total
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralAt, 16);

    return Buffer.concat([local, filename, contents, central, filename, end]);
};

/** The application's own package, as bytes. */
const wgt = () => zip('config.xml', readFileSync(join(__dirname, '..', '..', 'config.xml')));

/** Anything that is definitely not a Tizen package. */
const notAPackage = () => zip('readme.txt', Buffer.from('not a package', 'utf8'));

module.exports = { wgt, notAPackage, zip, crc32 };
