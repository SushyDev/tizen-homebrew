'use strict';

// Reading a certificate, which OpenSSL already does — this only names the parts Tizen cares about.

const { X509Certificate } = require('crypto');

const DEVICE = /URN:tizen:deviceid=([^,\s]+)/g;

const open = (pem) => {
    try {
        return new X509Certificate(pem);
    } catch (error) {
        return null;
    }
};

// The distributor certificate names its televisions in subjectAltName, one URI each.
const devicesIn = (pems) => [].concat(pems)
    .map(open)
    .filter(Boolean)
    .reduce((found, certificate) => [
        ...found,
        ...Array.from(String(certificate.subjectAltName || '').matchAll(DEVICE), (match) => match[1])
    ], [])
    .filter((device, index, all) => all.indexOf(device) === index);

const commonNameIn = (subject) => {
    const line = String(subject || '').split('\n').find((part) => part.indexOf('CN=') === 0);

    return line ? line.slice(3) : null;
};

const describe = (pem) => {
    const certificate = open(pem);

    if (!certificate) return null;

    return {
        subject: commonNameIn(certificate.subject),
        issuer: commonNameIn(certificate.issuer),
        from: new Date(certificate.validFrom),
        until: new Date(certificate.validTo),
        devices: devicesIn(pem)
    };
};

const expiresIn = (pem) => {
    const found = describe(pem);

    return found ? Math.floor((found.until.getTime() - Date.now()) / 86400000) : null;
};

module.exports = { devicesIn, describe, expiresIn };
