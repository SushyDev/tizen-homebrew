const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const DESCRIPTOR = 0x08074b50;
const HAS_DESCRIPTOR = 0x0008;

// An upload is the one source the service has no bytes for, so the same read happens here — a
// deliberate second copy of service/src/install/zip.js, kept honest by both producing
// `{ packageId, appId, name, version, isWgt, icon }`. It fails quietly: the service still refuses a bad
// package on install, with a reason.
//
// A File can be read at any offset, so the central directory at the end is asked first and only the
// entries wanted are read — a 60MB archive costs a few kilobytes, and a manifest 6MB in (Bravo's) is
// found. When there is no directory to read, the first HEAD bytes are walked, as before.
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

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const sliceOf = async (file, offset, length) => {
    try {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    } catch (e) {
        return null;
    }
};

const unpack = async (compression, data) => {
    if (compression === 0) return data;
    if (compression !== 8) return null;

    try {
        return await inflateRaw(data);
    } catch (e) {
        return null;
    }
};

// name -> { compression, compressedSize, localAt }, or null when there is no directory to read.
const directoryOf = async (file) => {
    const span = Math.min(file.size, 22 + 0xffff);
    const tail = await sliceOf(file, file.size - span, span);
    if (!tail || tail.length < 22) return null;

    const view = viewOf(tail);

    for (let at = tail.length - 22; at >= 0; at -= 1) {
        if (view.getUint32(at, true) !== END_OF_CENTRAL) continue;

        const entries = view.getUint16(at + 10, true);
        const size = view.getUint32(at + 12, true);
        const offset = view.getUint32(at + 16, true);

        if (offset + size > file.size) return null;

        const directory = await sliceOf(file, offset, size);
        if (!directory) return null;

        const listing = viewOf(directory);
        const found = new Map();
        let cursor = 0;

        for (let index = 0; index < entries; index += 1) {
            if (cursor + 46 > directory.length || listing.getUint32(cursor, true) !== CENTRAL_HEADER) return null;

            const nameLength = listing.getUint16(cursor + 28, true);
            const extraLength = listing.getUint16(cursor + 30, true);
            const commentLength = listing.getUint16(cursor + 32, true);
            const name = new TextDecoder().decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));

            found.set(name, {
                compression: listing.getUint16(cursor + 10, true),
                compressedSize: listing.getUint32(cursor + 20, true),
                localAt: listing.getUint32(cursor + 42, true)
            });

            cursor += 46 + nameLength + extraLength + commentLength;
        }

        return found;
    }

    return null;
};

const fromDirectory = async (file, entry) => {
    const header = await sliceOf(file, entry.localAt, 30);
    if (!header || header.length < 30 || viewOf(header).getUint32(0, true) !== LOCAL_HEADER) return null;

    const view = viewOf(header);
    const dataAt = entry.localAt + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const data = await sliceOf(file, dataAt, entry.compressedSize);

    if (!data || data.length < entry.compressedSize) return null;

    return unpack(entry.compression, data);
};

// A descriptor-style entry's size, from the descriptor after it — believed only when the size it records
// is the distance it was found at.
const descriptorAfter = (bytes, view, dataAt) => {
    for (let at = dataAt; at + 16 <= bytes.length; at += 1) {
        if (view.getUint32(at, true) === DESCRIPTOR && view.getUint32(at + 8, true) === at - dataAt) return at - dataAt;
    }

    return -1;
};

const fromHead = async (bytes, wanted) => {
    const view = viewOf(bytes);

    let cursor = 0;

    while (cursor + 30 <= bytes.length) {
        if (view.getUint32(cursor, true) !== LOCAL_HEADER) break;

        const flags = view.getUint16(cursor + 6, true);
        const compression = view.getUint16(cursor + 8, true);
        const nameLength = view.getUint16(cursor + 26, true);
        const extraLength = view.getUint16(cursor + 28, true);

        const nameAt = cursor + 30;
        const name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength));
        const dataAt = nameAt + nameLength + extraLength;

        let compressedSize = view.getUint32(cursor + 18, true);
        let trailer = 0;

        if (flags & HAS_DESCRIPTOR) {
            compressedSize = descriptorAfter(bytes, view, dataAt);
            if (compressedSize === -1) return null;
            trailer = 16;
        }

        if (name === wanted) {
            const data = bytes.subarray(dataAt, dataAt + compressedSize);
            return data.length < compressedSize ? null : unpack(compression, data);
        }

        cursor = dataAt + compressedSize + trailer;
    }

    return null;
};

// A reader over one file: the directory when there is one, the head when there is not.
const openArchive = async (file) => {
    const directory = await directoryOf(file);

    if (directory) {
        return (wanted) => (directory.has(wanted) ? fromDirectory(file, directory.get(wanted)) : Promise.resolve(null));
    }

    const head = await sliceOf(file, 0, HEAD);

    return (wanted) => (head ? fromHead(head, wanted) : Promise.resolve(null));
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

const iconOf = async (readFromZip, named) => {
    const candidates = [named, named ? `shared/res/${named}` : null, 'icon.png']
        .filter(Boolean)
        .filter((path, at, all) => all.indexOf(path) === at);

    for (const path of candidates) {
        const mime = MIME[path.split('.').pop().toLowerCase()];
        if (!mime) continue;

        const art = await readFromZip(path);
        if (!art || art.length === 0 || art.length > MAX_ICON) continue;

        return `data:${mime};base64,${base64(art)}`;
    }

    return null;
};

const readPackage = async (file) => {
    if (typeof DecompressionStream === 'undefined') return null;

    const readFromZip = await openArchive(file);

    const widget = await readFromZip('config.xml');

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
            icon: await iconOf(readFromZip, attribute(xml, 'icon', 'src'))
        };
    }

    const native = await readFromZip('tizen-manifest.xml');

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
            icon: await iconOf(readFromZip, text(xml, 'icon'))
        };
    }

    return null;
};

export { readPackage };
