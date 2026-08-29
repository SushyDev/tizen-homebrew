const LOCAL_HEADER = 0x04034b50;

// An upload is the one source the service has no bytes for, so the same read happens here — a
// deliberate second copy of the local-header walk in install/manifest.js, kept honest by both
// producing `{ packageId, appId, name, version, isWgt, icon }`. It fails quietly: the service still
// refuses a bad package on install, with a reason.
//
// A .wgt is front-loaded, so this much reaches the manifest and the icon without pulling a 60MB
// archive through a phone's memory to draw one row.
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

const inflateRaw = async (bytes) => {
    const expanded = new Response(bytes).body
        .pipeThrough(new DecompressionStream('deflate-raw'));

    return new Uint8Array(await new Response(expanded).arrayBuffer());
};

// Local file headers walked in order rather than the central directory, because the end of the
// file is exactly the part this deliberately does not have.
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

            if (data.length < compressedSize) return null;

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

const base64 = (bytes) => {
    let binary = '';

    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
    }

    return btoa(binary);
};

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
