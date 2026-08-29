'use strict';

const { deflateRawSync } = require('zlib');
const { readFileSync } = require('fs');
const { join } = require('path');

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

const zipAll = (entries) => {
    const bodies = [];
    const directory = [];
    let at = 0;

    entries.forEach(({ name, contents, deflate = false }) => {
        const filename = Buffer.from(name, 'utf8');
        const stored = deflate ? deflateRawSync(contents) : contents;
        const sum = crc32(contents);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);   // local file header
        local.writeUInt16LE(20, 4);           // version needed
        local.writeUInt16LE(0, 6);            // flags
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(sum, 14);
        local.writeUInt32LE(stored.length, 18);
        local.writeUInt32LE(contents.length, 22);
        local.writeUInt16LE(filename.length, 26);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // central directory header
        central.writeUInt16LE(20, 4);         // version made by
        central.writeUInt16LE(20, 6);         // version needed
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(sum, 16);
        central.writeUInt32LE(stored.length, 20);
        central.writeUInt32LE(contents.length, 24);
        central.writeUInt16LE(filename.length, 28);
        central.writeUInt32LE(at, 42);        // where its local header is

        bodies.push(local, filename, stored);
        directory.push(central, filename);

        at += local.length + filename.length + stored.length;
    });

    const central = Buffer.concat(directory);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);     // end of central directory
    end.writeUInt16LE(entries.length, 8); // entries on this disk
    end.writeUInt16LE(entries.length, 10);// entries total
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(at, 16);

    return Buffer.concat([Buffer.concat(bodies), central, end]);
};

const zip = (name, contents) => zipAll([{ name, contents }]);

const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

const wgt = () => zip('config.xml', readFileSync(join(__dirname, '..', '..', 'config.xml')));

const wgtWithIcon = () => zipAll([
    { name: 'config.xml', contents: readFileSync(join(__dirname, '..', '..', 'config.xml')), deflate: true },
    { name: 'icon.png', contents: PIXEL }
]);

const notAPackage = () => zip('readme.txt', Buffer.from('not a package', 'utf8'));

module.exports = { wgt, wgtWithIcon, notAPackage, zip, zipAll, crc32, PIXEL };
