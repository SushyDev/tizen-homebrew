'use strict';

// Reading a package's identity out of its manifest.
//
// A .wgt is a zip whose config.xml names the package; a .tpk uses
// tizen-manifest.xml. Both are read here without unzipping to disk and
// without an XML parser: xml2js cost 99KB of the bundle to extract two
// attributes, and `tools/push.js` had already proven the regex approach works
// against the very same files.
//
// The manifest also says where the application's own icon is, which is the
// one picture of itself a package carries. `install/preview.js` pulls those
// bytes back out of the same archive, so a phone can show the app rather than
// the name of the file it arrived in.

const { inflateRawSync } = require('zlib');

/**
 * Finds one file inside a zip and returns its bytes.
 *
 * This reads the local file headers in order rather than the central
 * directory. Manifests live at the front of a .wgt, so the match is found
 * almost immediately and there is no need to seek the end of the archive.
 */
const readFromZip = (archive, wanted) => {
    const LOCAL_HEADER = 0x04034b50;

    let cursor = 0;

    while (cursor + 30 <= archive.length) {
        if (archive.readUInt32LE(cursor) !== LOCAL_HEADER) break;

        const compression = archive.readUInt16LE(cursor + 8);
        const compressedSize = archive.readUInt32LE(cursor + 18);
        const nameLength = archive.readUInt16LE(cursor + 26);
        const extraLength = archive.readUInt16LE(cursor + 28);

        const nameAt = cursor + 30;
        const name = archive.slice(nameAt, nameAt + nameLength).toString('utf8');
        const dataAt = nameAt + nameLength + extraLength;

        if (name === wanted) {
            const data = archive.slice(dataAt, dataAt + compressedSize);
            // 0 is stored, 8 is deflate; a .wgt uses no other method.
            return compression === 0 ? data : inflateRawSync(data);
        }

        cursor = dataAt + compressedSize;
    }

    return null;
};

/**
 * Extracts the identity a package installs under.
 *
 * Returns `{ packageId, appId, name, version, iconPath, isWgt }`, or throws
 * when the file is not a Tizen package at all — which is the useful thing to
 * tell someone who uploaded the wrong file.
 */
const identify = (archive) => {
    const attribute = (xml, tag, key) => {
        const element = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
        if (!element) return null;
        const found = new RegExp(`\\b${key}="([^"]*)"`).exec(element[0]);
        return found ? found[1] : null;
    };

    const widget = readFromZip(archive, 'config.xml');

    if (widget) {
        const xml = widget.toString('utf8');
        const packageId = attribute(xml, 'tizen:application', 'package');

        if (!packageId) throw badPackage('config.xml declares no package id.');

        const named = /<name\b[^>]*>([^<]*)<\/name>/.exec(xml);

        return {
            packageId,
            appId: attribute(xml, 'tizen:application', 'id'),
            name: named ? named[1].trim() : null,
            version: attribute(xml, 'widget', 'version'),
            // `<icon src="icon.png"/>`, and the src is relative to the widget
            // root — which is the root of the zip, so it is already the entry
            // name to ask for.
            iconPath: attribute(xml, 'icon', 'src'),
            isWgt: true
        };
    }

    const native = readFromZip(archive, 'tizen-manifest.xml');

    if (native) {
        const xml = native.toString('utf8');
        const packageId = attribute(xml, 'manifest', 'package');

        if (!packageId) throw badPackage('tizen-manifest.xml declares no package id.');

        const icon = /<icon\b[^>]*>([^<]*)<\/icon>/.exec(xml);

        return {
            packageId,
            appId: attribute(xml, 'ui-application', 'appid'),
            name: null,
            version: attribute(xml, 'manifest', 'version'),
            // A native manifest names the icon as element text rather than an
            // attribute, and usually as a bare filename that lives under
            // shared/res — preview.js tries both.
            iconPath: icon ? icon[1].trim() : null,
            isWgt: false
        };
    }

    throw badPackage('No config.xml or tizen-manifest.xml — this is not a Tizen package.');
};

const badPackage = (message) => Object.assign(new Error(message), { code: 'badPackage' });

module.exports = { identify, readFromZip };
