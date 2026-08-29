'use strict';

// A .wgt reaches the interface as a filename, and the name, version, id and icon are all inside it.
//
// Nothing here throws: a preview is a courtesy, and pipeline.js is where a bad package is refused.

const { closeSync, openSync, readSync } = require('fs');

const manifest = require('./manifest.js');

// A .wgt is front-loaded, so two megabytes reaches the manifest and the icon — the alternative is
// pulling every 40MB app on a stick through the television's memory to draw a list.
const HEAD = 2 * 1024 * 1024;

const MAX_ICON = 512 * 1024;

const MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp'
};

const mimeOf = (path) => MIME[String(path).split('.').pop().toLowerCase()] || null;

const iconOf = (archive, identity) => {
    const named = identity && identity.iconPath;

    // A native package names the icon under shared/res; a widget's src is relative to the zip root.
    const candidates = [named, named ? `shared/res/${named}` : null, 'icon.png']
        .filter(Boolean)
        .filter((path, at, all) => all.indexOf(path) === at);

    for (const path of candidates) {
        const mime = mimeOf(path);
        if (!mime) continue;

        const bytes = (() => {
            try {
                return manifest.readFromZip(archive, path);
            } catch (e) {
                // A truncated head ends as a failed inflate rather than a missing entry.
                return null;
            }
        })();

        if (!bytes || bytes.length === 0 || bytes.length > MAX_ICON) continue;

        return `data:${mime};base64,${bytes.toString('base64')}`;
    }

    return null;
};

const describe = (archive, identity = null) => {
    const known = identity || (() => {
        try {
            return manifest.identify(archive);
        } catch (e) {
            return null;
        }
    })();

    if (!known) return null;

    return {
        packageId: known.packageId,
        appId: known.appId,
        name: known.name,
        version: known.version,
        isWgt: known.isWgt,
        icon: iconOf(archive, known)
    };
};

const describeFile = (path) => {
    const handle = (() => {
        try {
            return openSync(path, 'r');
        } catch (e) {
            return null;
        }
    })();

    if (handle === null) return null;

    try {
        const head = Buffer.alloc(HEAD);
        const read = readSync(handle, head, 0, HEAD, 0);

        return describe(head.slice(0, read));
    } catch (e) {
        return null;
    } finally {
        closeSync(handle);
    }
};

module.exports = { describe, describeFile, iconOf, HEAD, MAX_ICON };
