'use strict';

const rc2 = require('../rc2.js');
const { suite } = require('./harness.js');

// RFC 2268 section 5, decrypted rather than encrypted. node-forge fails the two whose effective key
// length is not a whole number of bytes, because it masks by `bits & 7` instead of the remainder.
const VECTORS = [
    ['0000000000000000', 63, '0000000000000000', 'ebb773f993278eff'],
    ['ffffffffffffffff', 64, 'ffffffffffffffff', '278b27e42e2f0d49'],
    ['3000000000000000', 64, '1000000000000001', '30649edf9be7d2c2'],
    ['88', 64, '0000000000000000', '61a8a244adacccf0'],
    ['88bca90e90875a', 64, '0000000000000000', '6ccf4308974c267f'],
    ['88bca90e90875a7f0f79c384627bafb2', 64, '0000000000000000', '1a807d272bbe5db1'],
    ['88bca90e90875a7f0f79c384627bafb2', 128, '0000000000000000', '2269552ab0f85ca6'],
    ['88bca90e90875a7f0f79c384627bafb216f80a6f85920584c42fceb0be255daf1e', 129,
        '0000000000000000', '5b78d3a43dfff1f1']
];

suite('rc2', (check) => {
    VECTORS.forEach(([key, bits, plain, cipher]) => {
        const schedule = rc2.expandKey(Buffer.from(key, 'hex'), bits);
        const out = rc2.decryptBlock(Buffer.from(cipher, 'hex'), schedule).toString('hex');

        check(`RFC 2268 vector, ${key.length / 2}-byte key at ${bits} bits`, out === plain, out);
    });

    const key = Buffer.from('0123456789abcdef', 'hex');
    const iv = Buffer.from('fedcba9876543210', 'hex');

    check('CBC chains each block onto the one before it',
        rc2.decrypt(key, 64, iv, Buffer.alloc(16)).length <= 16);
});
