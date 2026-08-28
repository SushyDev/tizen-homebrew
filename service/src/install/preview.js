'use strict';

// What a package says it is, before anything installs it.
//
// A .wgt arriving from a stick in the side of the set, or from a release
// somebody pasted a link to, reaches the interface as a filename — and a
// filename is the one fact about a package that nobody chose carefully.
// `Jellyfin_10.9.1_arm.wgt` is the good case; `download (2).wgt` is the
// ordinary one. Everything better than that is already inside the archive:
// the name the application calls itself, its version, the id it installs
// under, and the icon the television will show on the home row.
//
// So this reads those four things back out and hands them over together. It
// is the same zip walk `manifest.js` does — no unzipping to disk, no XML
// parser — with the icon's bytes carried as a data URI, because the thing
// asking is a phone at the other end of a socket and a second round trip for
// a 30KB PNG is not worth the route it would need.
//
// Nothing here throws. A preview is a courtesy: where a file turns out not to
// be a package at all, or to be one this cannot read, the answer is null and
// the interface falls back to the filename it already had. The install path is
// where a bad package is refused, loudly, with a reason — see pipeline.js.

const { closeSync, openSync, readSync } = require('fs');

const manifest = require('./manifest.js');

// How much of a file on disk to read before giving up on finding a manifest
// and an icon in it.
//
// A .wgt is front-loaded: the signatures, config.xml and the icon come before
// the application's own content, because that is the order the packaging tool
// writes them in. Two megabytes reaches all three with room to spare, and is
// the difference between listing a directory of packages and pulling every one
// of them — a stick with ten 40MB apps on it — through the television's memory
// to draw a list.
//
// It is still a real cost, and a synchronous one: a directory of twenty
// packages is forty megabytes read off a USB 2 stick before the listing goes
// out, which is a second or so of a service that does nothing else meanwhile.
// That is the price of a list that names applications instead of files, it is
// paid once per directory somebody opens, and the number above is the dial if
// it ever turns out to be the wrong trade.
const HEAD = 2 * 1024 * 1024;

// An icon larger than this is not an icon; it is a mistake, or a screenshot
// somebody pointed the manifest at. Sending it would cost more than the whole
// rest of the screen, so it is dropped and the tile falls back to a monogram.
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

/**
 * The application's own icon, as a data URI, or null.
 *
 * `identity` is what `manifest.identify` returned — the icon's path is in
 * there, which is what makes this a second cheap read of an archive already
 * in hand rather than a second parse of it.
 */
const iconOf = (archive, identity) => {
    const named = identity && identity.iconPath;

    // A native package names the icon as a bare filename and keeps the file
    // under shared/res. A widget's src is already relative to the zip root.
    // `icon.png` last is the convention every Tizen template ships with, and
    // it is right often enough to be worth one more walk of the archive.
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
                // A truncated head — see HEAD — ends as a failed inflate
                // rather than a missing entry, and that is not worth a word.
                return null;
            }
        })();

        if (!bytes || bytes.length === 0 || bytes.length > MAX_ICON) continue;

        return `data:${mime};base64,${bytes.toString('base64')}`;
    }

    return null;
};

/**
 * Everything a screen needs to show a package as itself.
 *
 * Returns `{ packageId, appId, name, version, isWgt, icon }`, or null for
 * anything that is not a package this can read. `identity` may be handed in
 * where the caller already parsed one — the install pipeline has, and reading
 * the same manifest a second time to reach the icon would be work for nothing.
 */
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

/** The same, for a package sitting on the television's own disk. */
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
