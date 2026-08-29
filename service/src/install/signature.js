'use strict';

const { createHash, createSign } = require('crypto');

// Lifted from `tizen/src/packageSigner.js`, handed PEM rather than a PKCS#12 — forge was a third
// of the service bundle, and the conversion now happens in tools/certificates.js. Everything else
// is upstream's verbatim, including the two constant digests and the 76-column wrapping.

const authorPropDigest = 'aXbSAVgmAz0GsBUeZ1UmNDRrxkWhDUVGb45dZcNRq429wX3X+x6kaXT3NdNDTSNVTU+ypkysPMGvQY10fG1EWQ==';
const distributorPropDigest = '/r5npk2VVA46QFJnejgONBEh4BWtjrtu9x/IFeLksjWyGmB/cMWKSJWQl7aU3YRQRZ3AesG8gF7qGyvKX9Snig==';

const wrap = (text) => text.replace(/(.{76})/g, '$1\n');

const createReference = (data, uri) => {
    const digest = uri === '#prop' ? data : createHash('sha512').update(data).digest('base64');

    const transform = '<Transforms>\n' +
        '<Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></Transform>\n' +
        '</Transforms>\n';

    return `<Reference URI="${uri}">\n` +
        `${uri === '#prop' ? transform : ''}` +
        '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"></DigestMethod>\n' +
        `<DigestValue>${wrap(digest)}</DigestValue>\n` +
        '</Reference>\n';
};

// Exclusive c14n reduced to one substitution; test/signature.js compares the result against the real thing.
const canonicalise = (signedInfo) => signedInfo
    .replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">')
    .replace(/\n$/, '');

const bodyOf = (pem) => wrap(String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/[\r\n]+/g, ''));

class Signature {
    constructor(id, files) {
        this.id = id;
        this.files = files;
        this.references = '';
        this.keyInfo = '';
        this.signedInfo = '';
        this.privateKey = '';
    }

    _createReferences() {
        for (const file of this.files) {
            this.references += createReference(file.data, file.uri);
        }

        this.references += createReference(
            this.id === 'AuthorSignature' ? authorPropDigest : distributorPropDigest, '#prop');
    }

    _addKeyInfo(pair) {
        this.keyInfo = '<KeyInfo>\n<X509Data>';

        for (const certificate of pair.certificates) {
            const body = bodyOf(certificate);
            this.keyInfo += `\n<X509Certificate>${body.startsWith('\n') ? '' : '\n'}${body}\n</X509Certificate>`;
        }

        this.keyInfo += '\n</X509Data>\n</KeyInfo>\n';
        this.privateKey = pair.key;
    }

    _generateSignature(key) {
        this.signedInfo += '<SignedInfo>\n' +
            '<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>\n' +
            '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"></SignatureMethod>\n' +
            this.references +
            '</SignedInfo>\n';

        const signed = createSign('RSA-SHA512').update(canonicalise(this.signedInfo)).sign(key, 'base64');

        this.signedInfo += `<SignatureValue>\n${wrap(signed)}\n</SignatureValue>\n`;
    }

    _generateSignatureXML() {
        return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="${this.id}">\n` +
            this.signedInfo +
            this.keyInfo +
            '<Object Id="prop">' +
            '<SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">' +
            `<SignatureProperty Id="profile" Target="#${this.id}">` +
            '<dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile">' +
            '</dsp:Profile>' +
            '</SignatureProperty>' +
            `<SignatureProperty Id="role" Target="#${this.id}">` +
            `<dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-${this.id === 'AuthorSignature' ? 'author' : 'distributor'}">` +
            '</dsp:Role>' +
            '</SignatureProperty>' +
            `<SignatureProperty Id="identifier" Target="#${this.id}">` +
            '<dsp:Identifier>' +
            '</dsp:Identifier></SignatureProperty></SignatureProperties></Object>\n' +
            '</Signature>\n';
    }

    async sign(pair) {
        this._createReferences();
        this._addKeyInfo(pair);
        this._generateSignature(this.privateKey);

        this.files.unshift({
            uri: this.id === 'AuthorSignature' ? 'author-signature.xml' : 'signature1.xml',
            data: Buffer.from(this._generateSignatureXML())
        });

        return this.files;
    }
}

module.exports = Signature;
