'use strict';

const OID = {
    data: '1.2.840.113549.1.7.1',
    encryptedData: '1.2.840.113549.1.7.6',

    keyBag: '1.2.840.113549.1.12.10.1.1',
    shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
    certBag: '1.2.840.113549.1.12.10.1.3',
    x509Certificate: '1.2.840.113549.1.9.22.1',

    friendlyName: '1.2.840.113549.1.9.20',
    localKeyId: '1.2.840.113549.1.9.21',

    pbeSHA1RC4128: '1.2.840.113549.1.12.1.1',
    pbeSHA1RC440: '1.2.840.113549.1.12.1.2',
    pbeSHA1TripleDES3: '1.2.840.113549.1.12.1.3',
    pbeSHA1TripleDES2: '1.2.840.113549.1.12.1.4',
    pbeSHA1RC2128: '1.2.840.113549.1.12.1.5',
    pbeSHA1RC240: '1.2.840.113549.1.12.1.6',

    pbes2: '1.2.840.113549.1.5.13',
    pbkdf2: '1.2.840.113549.1.5.12',

    hmacSHA1: '1.2.840.113549.2.7',
    hmacSHA224: '1.2.840.113549.2.8',
    hmacSHA256: '1.2.840.113549.2.9',
    hmacSHA384: '1.2.840.113549.2.10',
    hmacSHA512: '1.2.840.113549.2.11',

    tripleDESCBC: '1.2.840.113549.3.7',
    aes128CBC: '2.16.840.1.101.3.4.1.2',
    aes192CBC: '2.16.840.1.101.3.4.1.22',
    aes256CBC: '2.16.840.1.101.3.4.1.42',

    sha1: '1.3.14.3.2.26',
    sha256: '2.16.840.1.101.3.4.2.1',
    sha512: '2.16.840.1.101.3.4.2.3',

    rsaEncryption: '1.2.840.113549.1.1.1',
    sha512WithRSA: '1.2.840.113549.1.1.13',

    extensionRequest: '1.2.840.113549.1.9.14',
    subjectAltName: '2.5.29.17',

    commonName: '2.5.4.3',
    emailAddress: '1.2.840.113549.1.9.1',
    countryName: '2.5.4.6',
    stateOrProvinceName: '2.5.4.8',
    localityName: '2.5.4.7',
    organizationName: '2.5.4.10',
    organizationalUnitName: '2.5.4.11'
};

const NAMES = Object.keys(OID).reduce((all, name) => ({ ...all, [OID[name]]: name }), {});

module.exports = { OID, NAMES };
