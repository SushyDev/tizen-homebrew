'use strict';

// The key derivation PKCS#12 uses for its own PBE schemes and for the integrity MAC (RFC 7292 B.2).
// PBKDF2 is not interchangeable with it: a file written by Tizen Studio needs this one to open.

const { createHash } = require('crypto');

const BLOCK = { sha1: 64, sha256: 64, sha512: 128 };
const DIGEST = { sha1: 20, sha256: 32, sha512: 64 };

const PURPOSE = { key: 1, iv: 2, mac: 3 };

// UTF-16 big-endian with the terminator included, which is what makes a password's bytes.
const passwordBytes = (password) => Buffer.concat([
    Buffer.from(String(password), 'utf16le').swap16(),
    Buffer.from([0, 0])
]);

const repeated = (source, length) => (source.length === 0
    ? Buffer.alloc(0)
    : Buffer.from(Array.from({ length }, (unused, index) => source[index % source.length])));

const filled = (source, block) => repeated(source, Math.ceil(source.length / block) * block);

const digestTimes = (algorithm, times, input) => (times <= 1
    ? createHash(algorithm).update(input).digest()
    : digestTimes(algorithm, times - 1, createHash(algorithm).update(input).digest()));

// I + B + 1, block by block, each block a big-endian integer of the hash's block size.
const advance = (carrier, addend, block) => Buffer.concat(
    Array.from({ length: carrier.length / block }, (unused, index) => {
        const piece = carrier.subarray(index * block, (index + 1) * block);

        return Buffer.from(piece.reduceRight((state, byte, at) => {
            const total = byte + addend[at] + state.carry;

            return { carry: total >> 8, bytes: [total & 0xff, ...state.bytes] };
        }, { carry: 1, bytes: [] }).bytes);
    })
);

const derive = (algorithm, password, salt, iterations, purpose, wanted) => {
    const block = BLOCK[algorithm];
    const digest = DIGEST[algorithm];

    const diversifier = Buffer.alloc(block, purpose);
    const start = Buffer.concat([filled(salt, block), filled(passwordBytes(password), block)]);

    const rounds = Array.from({ length: Math.ceil(wanted / digest) });

    return Buffer.concat(rounds.reduce((state) => {
        const piece = digestTimes(algorithm, iterations, Buffer.concat([diversifier, state.carrier]));

        return {
            carrier: advance(state.carrier, repeated(piece, block), block),
            pieces: [...state.pieces, piece]
        };
    }, { carrier: start, pieces: [] }).pieces).subarray(0, wanted);
};

module.exports = { derive, passwordBytes, PURPOSE, DIGEST };
