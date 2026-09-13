'use strict';

// The two XML signatures a Tizen package carries. Byte-for-byte what Tizen Studio's signer emits,
// including the constant `#prop` digests and the 76-column wrapping, because a television compares
// the canonicalised bytes and not the meaning.

const { createHash, createSign } = require('crypto');

const PROP_DIGEST = {
    AuthorSignature: 'aXbSAVgmAz0GsBUeZ1UmNDRrxkWhDUVGb45dZcNRq429wX3X+x6kaXT3NdNDTSNVTU+ypkysPMGvQY10fG1EWQ==',
    DistributorSignature: '/r5npk2VVA46QFJnejgONBEh4BWtjrtu9x/IFeLksjWyGmB/cMWKSJWQl7aU3YRQRZ3AesG8gF7qGyvKX9Snig=='
};

const FILENAME = {
    AuthorSignature: 'author-signature.xml',
    DistributorSignature: 'signature1.xml'
};

const TRANSFORM = '<Transforms>\n' +
    '<Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></Transform>\n' +
    '</Transforms>\n';

const wrap = (text) => text.replace(/(.{76})/g, '$1\n');

const reference = (data, uri) => {
    const digest = uri === '#prop' ? data : createHash('sha512').update(data).digest('base64');

    return `<Reference URI="${uri}">\n` +
        `${uri === '#prop' ? TRANSFORM : ''}` +
        '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"></DigestMethod>\n' +
        `<DigestValue>${wrap(digest)}</DigestValue>\n` +
        '</Reference>\n';
};

const references = (id, files) => [
    ...files.map((file) => reference(file.data, file.uri)),
    reference(PROP_DIGEST[id], '#prop')
].join('');

// Exclusive canonicalisation of this one document is a single substitution: the element inherits the
// signature namespace and carries nothing else. test/signing.js holds the output it has to match.
const canonicalise = (signedInfo) => signedInfo
    .replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">')
    .replace(/\n$/, '');

const signedInfo = (id, files) => '<SignedInfo>\n' +
    '<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>\n' +
    '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"></SignatureMethod>\n' +
    references(id, files) +
    '</SignedInfo>\n';

const bodyOf = (pem) => wrap(String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/[\r\n]+/g, ''));

const keyInfo = (certificates) => `${certificates.reduce((text, certificate) => {
    const body = bodyOf(certificate);

    return `${text}\n<X509Certificate>${body.startsWith('\n') ? '' : '\n'}${body}\n</X509Certificate>`;
}, '<KeyInfo>\n<X509Data>')}\n</X509Data>\n</KeyInfo>\n`;

const properties = (id) => '<Object Id="prop">' +
    '<SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">' +
    `<SignatureProperty Id="profile" Target="#${id}">` +
    '<dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile">' +
    '</dsp:Profile>' +
    '</SignatureProperty>' +
    `<SignatureProperty Id="role" Target="#${id}">` +
    `<dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-${id === 'AuthorSignature' ? 'author' : 'distributor'}">` +
    '</dsp:Role>' +
    '</SignatureProperty>' +
    `<SignatureProperty Id="identifier" Target="#${id}">` +
    '<dsp:Identifier>' +
    '</dsp:Identifier></SignatureProperty></SignatureProperties></Object>\n';

const document = (id, files, pair) => {
    const info = signedInfo(id, files);
    const value = createSign('RSA-SHA512').update(canonicalise(info)).sign(pair.key, 'base64');

    return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="${id}">\n` +
        `${info}<SignatureValue>\n${wrap(value)}\n</SignatureValue>\n` +
        keyInfo(pair.certificates) +
        properties(id) +
        '</Signature>\n';
};

// A new list rather than an edit of the one handed in, with the signature first.
const signature = (id, files, pair) => ({
    uri: FILENAME[id],
    data: Buffer.from(document(id, files, pair))
});

const sign = (files, pair) => {
    const authored = [signature('AuthorSignature', files, pair.author), ...files];

    return [signature('DistributorSignature', authored, pair.distributor), ...authored];
};

module.exports = { sign, signature, FILENAME, PROP_DIGEST, canonicalise, bodyOf };
