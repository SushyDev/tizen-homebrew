'use strict';

// DER, only the shapes a certificate request and a PKCS#12 are made of. The reader also accepts
// BER's indefinite lengths, because Java writes them and a Tizen Studio profile is a Java file.

const TAG = {
    BOOLEAN: 0x01,
    INTEGER: 0x02,
    BIT_STRING: 0x03,
    OCTET_STRING: 0x04,
    NULL: 0x05,
    OID: 0x06,
    UTF8_STRING: 0x0c,
    PRINTABLE_STRING: 0x13,
    T61_STRING: 0x14,
    IA5_STRING: 0x16,
    UTC_TIME: 0x17,
    GENERALIZED_TIME: 0x18,
    BMP_STRING: 0x1e,
    SEQUENCE: 0x30,
    SET: 0x31
};

const CONSTRUCTED = 0x20;

const contextTag = (number, constructed) => 0x80 | (constructed ? CONSTRUCTED : 0) | number;

const lengthBytes = (count) => {
    if (count < 0x80) return Buffer.from([count]);

    const hex = count.toString(16);
    const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');

    return Buffer.concat([Buffer.from([0x80 | body.length]), body]);
};

const node = (tag, contents) => Buffer.concat([Buffer.from([tag]), lengthBytes(contents.length), contents]);

const sequence = (parts) => node(TAG.SEQUENCE, Buffer.concat(parts));
const set = (parts) => node(TAG.SET, Buffer.concat(parts));
const octets = (buffer) => node(TAG.OCTET_STRING, buffer);
const bitString = (buffer) => node(TAG.BIT_STRING, Buffer.concat([Buffer.from([0]), buffer]));
const nul = () => node(TAG.NULL, Buffer.alloc(0));
const utf8 = (text) => node(TAG.UTF8_STRING, Buffer.from(text, 'utf8'));
const printable = (text) => node(TAG.PRINTABLE_STRING, Buffer.from(text, 'ascii'));
const ia5 = (text) => node(TAG.IA5_STRING, Buffer.from(text, 'ascii'));

// A PKCS#12 password is a BMPString: UTF-16 big-endian, and the KDF wants its two trailing nulls.
const bmp = (text) => node(TAG.BMP_STRING, Buffer.from(text, 'utf16le').swap16());

const explicit = (number, parts) => node(contextTag(number, true), Buffer.concat(parts));
const implicit = (number, buffer) => node(contextTag(number, false), buffer);

// Two's complement, so a leading bit that reads as a sign gets a zero byte in front of it.
const integer = (value) => {
    const digits = typeof value === 'number'
        ? Buffer.from(value.toString(16).padStart(value.toString(16).length + (value.toString(16).length % 2), '0'), 'hex')
        : value;

    const trimmed = digits.length && digits[0] === 0 && digits.length > 1 && digits[1] < 0x80
        ? digits.subarray(1)
        : digits;

    return node(TAG.INTEGER, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};

const base128 = (value) => {
    const groups = (rest, tail) => (rest === 0 ? tail : groups(Math.floor(rest / 128), [rest % 128, ...tail]));
    const body = value === 0 ? [0] : groups(value, []);

    return Buffer.from(body.map((byte, index) => (index === body.length - 1 ? byte : byte | 0x80)));
};

const oidBytes = (dotted) => {
    const parts = dotted.split('.').map(Number);

    return Buffer.concat([base128(parts[0] * 40 + parts[1]), ...parts.slice(2).map(base128)]);
};

const oid = (dotted) => node(TAG.OID, oidBytes(dotted));

const malformed = (message) => Object.assign(new Error(message), { code: 'derMalformed' });

// Indefinite length is legal only on a constructed value, so the sentinel is only read as one there.
const readAt = (buffer, at) => {
    if (at + 2 > buffer.length) throw malformed(`A value at byte ${at} runs past the end of the data.`);

    const tag = buffer[at];
    const first = buffer[at + 1];

    if (first === 0x80 && (tag & CONSTRUCTED)) {
        const end = endOfIndefinite(buffer, at + 2);

        return { tag, start: at + 2, end, contents: buffer.subarray(at + 2, end), raw: buffer.subarray(at, end + 2), next: end + 2 };
    }

    const long = first & 0x80 ? first & 0x7f : 0;
    const length = long ? Number(`0x${buffer.subarray(at + 2, at + 2 + long).toString('hex')}`) : first;
    const start = at + 2 + long;
    const end = start + length;

    if (end > buffer.length) throw malformed(`A value at byte ${at} declares ${length} bytes, past the end of the data.`);

    return { tag, start, end, contents: buffer.subarray(start, end), raw: buffer.subarray(at, end), next: end };
};

const endOfIndefinite = (buffer, at) => (buffer[at] === 0 && buffer[at + 1] === 0
    ? at
    : endOfIndefinite(buffer, readAt(buffer, at).next));

const read = (buffer) => readAt(buffer, 0);

// Every value in a buffer, one level deep.
const items = (buffer) => {
    const collect = (at, found) => {
        if (at >= buffer.length) return found;

        const value = readAt(buffer, at);

        return collect(value.next, [...found, value]);
    };

    return collect(0, []);
};

const children = (value) => items(value.contents);

const dotted = (value) => {
    const bytes = Array.from(value.contents);

    const groups = bytes.reduce((state, byte) => (byte & 0x80
        ? { ...state, partial: state.partial * 128 + (byte & 0x7f) }
        : { partial: 0, found: [...state.found, state.partial * 128 + byte] }), { partial: 0, found: [] }).found;

    return [Math.floor(groups[0] / 40), groups[0] % 40, ...groups.slice(1)].join('.');
};

const number = (value) => Number(`0x${value.contents.toString('hex') || '0'}`);

// A BER octet string may arrive in constructed pieces, and the pieces are the value.
const bytesOf = (value) => (value.tag & CONSTRUCTED
    ? Buffer.concat(items(value.contents).map(bytesOf))
    : value.contents);

const text = (value) => (value.tag === TAG.BMP_STRING
    ? Buffer.from(value.contents).swap16().toString('utf16le')
    : value.contents.toString('utf8'));

module.exports = {
    TAG, CONSTRUCTED, contextTag,
    node, sequence, set, octets, bitString, nul, utf8, printable, ia5, bmp, integer, oid, oidBytes,
    explicit, implicit,
    read, readAt, items, children, dotted, number, bytesOf, text
};
