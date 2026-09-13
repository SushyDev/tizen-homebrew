'use strict';

// The certificate request Samsung's CA is asked to sign. The distributor one names the televisions,
// a subjectAltName URI each, and that is what binds a package to a set.

const { generateKeyPairSync, createSign, createPublicKey } = require('crypto');

const der = require('./der.js');
const { OID } = require('./oids.js');

const KEY_BITS = 2048;

// PrintableString throughout, including the address: it is what the Samsung CA has been issuing
// against, and it copies the request's encoding into the certificate it returns.
const relative = (oid, value) => der.set([der.sequence([der.oid(oid), der.printable(value)])]);

const name = (entries) => der.sequence(entries
    .filter((entry) => entry && entry.value)
    .map((entry) => relative(entry.oid, String(entry.value))));

const uri = (value) => der.implicit(6, Buffer.from(value, 'ascii'));

const subjectAltName = (uris) => der.sequence([
    der.oid(OID.extensionRequest),
    der.set([der.sequence([der.sequence([
        der.oid(OID.subjectAltName),
        der.octets(der.sequence(uris.map(uri)))
    ])])])
]);

const spki = (key) => (key.type === 'public' ? key : createPublicKey(key))
    .export({ type: 'spki', format: 'der' });

const requestInfo = (subject, publicKey, attributes) => der.sequence([
    der.integer(0),
    subject,
    spki(publicKey),
    der.explicit(0, attributes)
]);

const sign = (info, privateKey) => der.sequence([
    info,
    der.sequence([der.oid(OID.sha512WithRSA), der.nul()]),
    der.bitString(createSign('sha512').update(info).sign(privateKey))
]);

const pem = (bytes) => `-----BEGIN CERTIFICATE REQUEST-----\n${
    (bytes.toString('base64').match(/.{1,64}/g) || []).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;

const request = (subject, attributes) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: KEY_BITS });

    return {
        csr: pem(sign(requestInfo(subject, publicKey, attributes), privateKey)),
        key: privateKey.export({ type: 'pkcs8', format: 'pem' })
    };
};

const author = ({ name: commonName }) => request(name([{ oid: OID.commonName, value: commonName }]), []);

// The empty package id is in every request Tizen Studio makes, and a set will not install without it.
const distributor = ({ email, devices }) => request(
    name([
        { oid: OID.commonName, value: 'TizenSDK' },
        { oid: OID.emailAddress, value: email }
    ]),
    [subjectAltName([
        'URN:tizen:packageid=',
        ...devices.map((device) => `URN:tizen:deviceid=${device}`)
    ])]
);

module.exports = { author, distributor, request, name, KEY_BITS };
