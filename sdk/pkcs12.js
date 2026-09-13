'use strict';

// PKCS#12, read and written directly. A pair minted here, one from Tizen Studio and one from
// node-forge all open the same way; what is written back uses only algorithms OpenSSL 3 still
// carries in its default provider, so the file stays readable without the legacy one.

const {
    createDecipheriv, createHmac, createPrivateKey, createPublicKey, randomBytes, createHash, pbkdf2Sync
} = require('crypto');

const der = require('./der.js');
const rc2 = require('./rc2.js');
const { OID } = require('./oids.js');
const { derive, PURPOSE } = require('./kdf.js');

const MAC_ITERATIONS = 2048;

const refuse = (message) => Object.assign(new Error(message), { code: 'pkcs12Failed', isFriendly: true });

const PBE = {
    [OID.pbeSHA1TripleDES3]: { cipher: 'des-ede3-cbc', keyBytes: 24, ivBytes: 8 },
    [OID.pbeSHA1TripleDES2]: { cipher: 'des-ede3-cbc', keyBytes: 16, ivBytes: 8, widen: true },
    [OID.pbeSHA1RC2128]: { rc2Bits: 128, keyBytes: 16, ivBytes: 8 },
    [OID.pbeSHA1RC240]: { rc2Bits: 40, keyBytes: 5, ivBytes: 8 }
};

const PBES2_CIPHERS = {
    [OID.aes128CBC]: { cipher: 'aes-128-cbc', keyBytes: 16 },
    [OID.aes192CBC]: { cipher: 'aes-192-cbc', keyBytes: 24 },
    [OID.aes256CBC]: { cipher: 'aes-256-cbc', keyBytes: 32 },
    [OID.tripleDESCBC]: { cipher: 'des-ede3-cbc', keyBytes: 24 }
};

const PRF = {
    [OID.hmacSHA1]: 'sha1',
    [OID.hmacSHA224]: 'sha224',
    [OID.hmacSHA256]: 'sha256',
    [OID.hmacSHA384]: 'sha384',
    [OID.hmacSHA512]: 'sha512'
};

const MAC_DIGESTS = {
    [OID.sha1]: 'sha1',
    [OID.sha256]: 'sha256',
    [OID.sha512]: 'sha512'
};

const algorithmOf = (value) => {
    const parts = der.children(value);

    return { oid: der.dotted(parts[0]), parameters: parts[1] || null };
};

// A 2-key triple DES key is the 16 bytes with its first 8 repeated.
const widened = (key) => Buffer.concat([key, key.subarray(0, 8)]);

const pbes1 = (algorithm, password, data) => {
    const scheme = PBE[algorithm.oid];
    const parameters = der.children(algorithm.parameters);
    const salt = der.bytesOf(parameters[0]);
    const iterations = der.number(parameters[1]);

    const key = derive('sha1', password, salt, iterations, PURPOSE.key, scheme.keyBytes);
    const iv = derive('sha1', password, salt, iterations, PURPOSE.iv, scheme.ivBytes);

    if (scheme.rc2Bits) return rc2.decrypt(key, scheme.rc2Bits, iv, data);

    const decipher = createDecipheriv(scheme.cipher, scheme.widen ? widened(key) : key, iv);

    return Buffer.concat([decipher.update(data), decipher.final()]);
};

const pbes2 = (algorithm, password, data) => {
    const [derivation, encryption] = der.children(algorithm.parameters).map(algorithmOf);

    if (derivation.oid !== OID.pbkdf2) {
        throw refuse(`That certificate file derives its key with ${derivation.oid}, which this cannot do.`);
    }

    const scheme = PBES2_CIPHERS[encryption.oid];

    if (!scheme) {
        throw refuse(`That certificate file is encrypted with ${encryption.oid}, which this cannot open.`);
    }

    const parameters = der.children(derivation.parameters);
    const salt = der.bytesOf(parameters[0]);
    const iterations = der.number(parameters[1]);

    const stated = parameters.find((part) => part.tag === der.TAG.INTEGER && part !== parameters[1]);
    const prf = parameters.find((part) => part.tag === der.TAG.SEQUENCE);

    const key = pbkdf2Sync(
        Buffer.from(String(password), 'utf8'),
        salt,
        iterations,
        stated ? der.number(stated) : scheme.keyBytes,
        prf ? PRF[der.dotted(der.children(prf)[0])] || 'sha1' : 'sha1'
    );

    const decipher = createDecipheriv(scheme.cipher, key, der.bytesOf(encryption.parameters));

    return Buffer.concat([decipher.update(data), decipher.final()]);
};

const decrypt = (algorithm, password, data) => {
    if (PBE[algorithm.oid]) return pbes1(algorithm, password, data);
    if (algorithm.oid === OID.pbes2) return pbes2(algorithm, password, data);

    throw refuse(
        `That certificate file is sealed with ${algorithm.oid}, which this cannot open.\n` +
        '  Re-mint the pair, or export it again as PKCS#12 with AES or triple DES.'
    );
};

const pemOf = (label, bytes) => `-----BEGIN ${label}-----\n${
    (bytes.toString('base64').match(/.{1,64}/g) || []).join('\n')}\n-----END ${label}-----\n`;

// SafeContents arrives either in the clear or as a PKCS#7 EncryptedData wrapper around the same thing.
const safeContentsOf = (contentInfo, password) => {
    const parts = der.children(contentInfo);
    const type = der.dotted(parts[0]);
    const content = der.children(parts[1])[0];

    if (type === OID.data) return der.bytesOf(content);

    if (type !== OID.encryptedData) {
        throw refuse(`That certificate file holds a ${type} section, which is not part of a PKCS#12.`);
    }

    const encrypted = der.children(der.children(content)[1]);
    const algorithm = algorithmOf(encrypted[1]);

    return decrypt(algorithm, password, der.bytesOf(encrypted[2]));
};

const readBag = (bag, password) => {
    const parts = der.children(bag);
    const type = der.dotted(parts[0]);
    const value = der.children(parts[1])[0];

    if (type === OID.certBag) {
        const inner = der.children(value);

        if (der.dotted(inner[0]) !== OID.x509Certificate) return null;

        return { kind: 'certificate', pem: pemOf('CERTIFICATE', der.bytesOf(der.children(inner[1])[0])) };
    }

    if (type === OID.keyBag) {
        return {
            kind: 'key',
            pem: createPrivateKey({ key: Buffer.from(value.raw), format: 'der', type: 'pkcs8' })
                .export({ type: 'pkcs8', format: 'pem' })
        };
    }

    if (type === OID.shroudedKeyBag) {
        // OpenSSL opens an EncryptedPrivateKeyInfo itself, including the PKCS#12 schemes.
        const opened = (() => {
            try {
                return createPrivateKey({
                    key: Buffer.from(value.raw),
                    format: 'der',
                    type: 'pkcs8',
                    passphrase: String(password)
                });
            } catch (error) {
                throw refuse('That certificate file did not open — wrong password?');
            }
        })();

        return { kind: 'key', pem: opened.export({ type: 'pkcs8', format: 'pem' }) };
    }

    return null;
};

const verifyMac = (macData, safeBytes, password) => {
    const parts = der.children(macData);
    const digestInfo = der.children(parts[0]);
    const algorithm = MAC_DIGESTS[der.dotted(der.children(digestInfo[0])[0])];

    if (!algorithm) return;

    const stored = der.bytesOf(digestInfo[1]);
    const salt = der.bytesOf(parts[1]);
    const iterations = parts[2] ? der.number(parts[2]) : 1;

    const key = derive(algorithm, password, salt, iterations, PURPOSE.mac, stored.length);
    const computed = createHmac(algorithm, key).update(safeBytes).digest();

    if (!computed.equals(stored)) {
        throw refuse('That certificate file did not open — the password does not match it.');
    }
};

const read = (bytes, password) => {
    const pfx = (() => {
        try {
            return der.children(der.read(Buffer.from(bytes)));
        } catch (error) {
            throw refuse('That certificate file is not a PKCS#12 — it did not parse as one.');
        }
    })();

    if (pfx.length < 2) throw refuse('That certificate file is not a PKCS#12 — it holds no signed data.');

    const authSafe = der.children(pfx[1]);

    if (der.dotted(authSafe[0]) !== OID.data) {
        throw refuse('That certificate file is not a password-protected PKCS#12.');
    }

    const safeBytes = der.bytesOf(der.children(authSafe[1])[0]);

    if (pfx[2]) verifyMac(pfx[2], safeBytes, password);

    const bags = der.children(der.read(safeBytes))
        .map((contentInfo) => safeContentsOf(contentInfo, password))
        .reduce((all, contents) => [...all, ...der.children(der.read(contents))], []);

    const found = bags.map((bag) => readBag(bag, password)).filter(Boolean);

    const certificates = found.filter((entry) => entry.kind === 'certificate').map((entry) => entry.pem);
    const key = (found.find((entry) => entry.kind === 'key') || {}).pem || null;

    if (!certificates.length) throw refuse('That certificate file holds no certificate.');
    if (!key) throw refuse('That certificate file holds no private key.');

    return { certificates, key };
};

const attribute = (oid, value) => der.sequence([der.oid(oid), der.set([value])]);

const certificateBag = (pem, attributes) => der.sequence([
    der.oid(OID.certBag),
    der.explicit(0, [der.sequence([
        der.oid(OID.x509Certificate),
        der.explicit(0, [der.octets(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'))])
    ])]),
    ...(attributes.length ? [der.set(attributes)] : [])
]);

const keyBag = (key, password, attributes) => der.sequence([
    der.oid(OID.shroudedKeyBag),
    der.explicit(0, [createPrivateKey(key).export({
        type: 'pkcs8',
        format: 'der',
        cipher: 'aes-256-cbc',
        passphrase: String(password)
    })]),
    ...(attributes.length ? [der.set(attributes)] : [])
]);

const plainSafe = (bags) => der.sequence([
    der.oid(OID.data),
    der.explicit(0, [der.octets(der.sequence(bags))])
]);

const write = ({ certificates, key, password, friendlyName }) => {
    const name = friendlyName || 'UserCertificate';
    const localKeyId = createHash('sha1')
        .update(createPublicKey(certificates[0]).export({ type: 'spki', format: 'der' }))
        .digest();

    const marks = [
        attribute(OID.localKeyId, der.octets(localKeyId)),
        attribute(OID.friendlyName, der.bmp(name))
    ];

    const certificateBags = certificates.map((pem, index) => certificateBag(pem, index === 0 ? marks : []));

    const safeBytes = der.sequence([plainSafe(certificateBags), plainSafe([keyBag(key, password, marks)])]);

    const salt = randomBytes(8);
    const macKey = derive('sha1', password, salt, MAC_ITERATIONS, PURPOSE.mac, 20);
    const mac = createHmac('sha1', macKey).update(safeBytes).digest();

    return der.sequence([
        der.integer(3),
        der.sequence([der.oid(OID.data), der.explicit(0, [der.octets(safeBytes)])]),
        der.sequence([
            der.sequence([der.sequence([der.oid(OID.sha1), der.nul()]), der.octets(mac)]),
            der.octets(salt),
            der.integer(MAC_ITERATIONS)
        ])
    ]);
};

module.exports = { read, write };
