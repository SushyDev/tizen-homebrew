// Reading a package on the phone, before it goes anywhere.
//
// Every other source names itself over the socket: the service has the bytes,
// so `install/preview.js` opens them and sends back what the package calls
// itself. An upload is the one case where the service has nothing — the file
// is sitting on the phone, and the whole question is whether to spend a
// minute of somebody's wifi on it. Asking them to upload it first in order to
// find out what it is gets the order exactly wrong.
//
// So the same read happens here. It is a deliberate second copy of a small
// piece of `install/manifest.js` — the local-header walk and two regexes —
// and it is the one duplication in this repository that cannot be removed by
// moving code, because the two copies run on different machines with
// different bytes in front of them. What keeps them honest is that they
// produce the same shape, `{ packageId, appId, name, version, isWgt, icon }`,
// and one card in `views/screens.js` renders either.
//
// It is also the reason this is allowed to fail quietly. A browser too old
// for DecompressionStream, an archive that puts its manifest somewhere
// unusual, a file that is not a package at all — every one of them returns
// null, and the interface shows the filename it would have shown anyway. The
// service still refuses a bad package on install, with a reason. This is a
// courtesy, not a gate.

const LOCAL_HEADER = 0x04034b50;

// How much of the file to look at. A .wgt is front-loaded — signatures, then
// config.xml, then the icon, then the application itself — so this reaches
// everything needed without pulling a 60MB archive through a phone's memory
// to draw one row. The service reads the same amount off its own disk for the
// same reason; see preview.js, which is also where the number is argued.
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

/**
 * Expands a deflated zip entry.
 *
 * `deflate-raw` is the platform's own inflate, which is why there is no zip
 * library in this bundle. It arrived in Safari 16.4 and Chrome 103; on
 * anything older this throws and the caller treats the entry as unreadable.
 */
const inflateRaw = async (bytes) => {
    const expanded = new Response(bytes).body
        .pipeThrough(new DecompressionStream('deflate-raw'));

    return new Uint8Array(await new Response(expanded).arrayBuffer());
};

/**
 * Finds one file inside a zip and returns its bytes, or null.
 *
 * The local file headers are walked in order rather than the central
 * directory being read from the end, because the end is exactly the part of
 * the file this deliberately does not have.
 */
const readFromZip = async (bytes, wanted) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let cursor = 0;

    while (cursor + 30 <= bytes.length) {
        if (view.getUint32(cursor, true) !== LOCAL_HEADER) break;

        const compression = view.getUint16(cursor + 8, true);
        const compressedSize = view.getUint32(cursor + 18, true);
        const nameLength = view.getUint16(cursor + 26, true);
        const extraLength = view.getUint16(cursor + 28, true);

        const nameAt = cursor + 30;
        const name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength));
        const dataAt = nameAt + nameLength + extraLength;

        if (name === wanted) {
            const data = bytes.subarray(dataAt, dataAt + compressedSize);

            // Short of the whole entry: the head stopped inside it. Nothing
            // useful can be made of a partial file, and saying so is better
            // than handing back half a PNG.
            if (data.length < compressedSize) return null;

            // 0 is stored, 8 is deflate; a .wgt uses no other method.
            if (compression === 0) return data;

            try {
                return await inflateRaw(data);
            } catch (e) {
                return null;
            }
        }

        cursor = dataAt + compressedSize;
    }

    return null;
};

/** The first attribute of the first `<tag …>` in some XML, or null. */
const attribute = (xml, tag, key) => {
    const element = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
    if (!element) return null;

    const found = new RegExp(`\\b${key}="([^"]*)"`).exec(element[0]);
    return found ? found[1] : null;
};

const text = (xml, tag) => {
    const found = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`).exec(xml);
    return found ? found[1].trim() : null;
};

/** Base64 for bytes, in chunks small enough not to overflow the argument list. */
const base64 = (bytes) => {
    let binary = '';

    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
    }

    return btoa(binary);
};

/** The application's own icon, as a data URI, or null. */
const iconOf = async (bytes, named) => {
    const candidates = [named, named ? `shared/res/${named}` : null, 'icon.png']
        .filter(Boolean)
        .filter((path, at, all) => all.indexOf(path) === at);

    for (const path of candidates) {
        const mime = MIME[path.split('.').pop().toLowerCase()];
        if (!mime) continue;

        const art = await readFromZip(bytes, path);
        if (!art || art.length === 0 || art.length > MAX_ICON) continue;

        return `data:${mime};base64,${base64(art)}`;
    }

    return null;
};

/**
 * What a chosen file says it is.
 *
 * Returns `{ packageId, appId, name, version, isWgt, icon }` — the same shape
 * the service sends for every other source — or null for anything this cannot
 * read.
 */
const readPackage = async (file) => {
    if (typeof DecompressionStream === 'undefined') return null;

    const bytes = await (async () => {
        try {
            return new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
        } catch (e) {
            return null;
        }
    })();

    if (!bytes) return null;

    const widget = await readFromZip(bytes, 'config.xml');

    if (widget) {
        const xml = new TextDecoder().decode(widget);
        const packageId = attribute(xml, 'tizen:application', 'package');

        if (!packageId) return null;

        return {
            packageId,
            appId: attribute(xml, 'tizen:application', 'id'),
            name: text(xml, 'name'),
            version: attribute(xml, 'widget', 'version'),
            isWgt: true,
            icon: await iconOf(bytes, attribute(xml, 'icon', 'src'))
        };
    }

    const native = await readFromZip(bytes, 'tizen-manifest.xml');

    if (native) {
        const xml = new TextDecoder().decode(native);
        const packageId = attribute(xml, 'manifest', 'package');

        if (!packageId) return null;

        return {
            packageId,
            appId: attribute(xml, 'ui-application', 'appid'),
            name: null,
            version: attribute(xml, 'manifest', 'version'),
            isWgt: false,
            icon: await iconOf(bytes, text(xml, 'icon'))
        };
    }

    return null;
};

export { readPackage };
