'use strict';

const { createVerify, createPublicKey } = require('crypto');

const der = require('../der.js');
const pkcs10 = require('../pkcs10.js');
const { OID } = require('../oids.js');
const { suite } = require('./harness.js');

const bytesOfPem = (pem) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');

const uris = (csr) => {
    const info = der.children(der.read(bytesOfPem(csr)))[0];
    const attributes = der.children(info).find((part) => part.tag === der.contextTag(0, true));

    if (!attributes) return [];

    const attribute = der.children(attributes)[0];
    const extensions = der.children(der.children(attribute)[1])[0];

    const extension = der.children(extensions)
        .find((entry) => der.dotted(der.children(entry)[0]) === OID.subjectAltName);

    if (!extension) return [];

    return der.children(der.read(der.bytesOf(der.children(extension)[1])))
        .map((name) => name.contents.toString('ascii'));
};

// The request is signed over its own first element, which is what the certificate authority checks.
const selfConsistent = (request) => {
    const parts = der.children(der.read(bytesOfPem(request)));
    const info = parts[0];
    const publicKey = createPublicKey({
        key: Buffer.from(der.children(info)[2].raw),
        format: 'der',
        type: 'spki'
    });

    return createVerify('sha512')
        .update(Buffer.from(info.raw))
        .verify(publicKey, parts[2].contents.subarray(1));
};

suite('pkcs10', (check) => {
    const author = pkcs10.author({ name: 'a person' });

    check('an author request is a certificate request', /BEGIN CERTIFICATE REQUEST/.test(author.csr));
    check('an author request signs itself', selfConsistent(author.csr));
    check('an author request comes with its private key', /BEGIN PRIVATE KEY/.test(author.key));

    const distributor = pkcs10.distributor({
        email: 'someone@example.com',
        devices: ['TESTSET0001', 'TESTSET0002']
    });

    check('a distributor request signs itself', selfConsistent(distributor.csr));

    const named = uris(distributor.csr);

    check('the empty package id leads the alternative names',
        named[0] === 'URN:tizen:packageid=', named.join(' '));

    check('every television is named once',
        named.slice(1).join(',') === 'URN:tizen:deviceid=TESTSET0001,URN:tizen:deviceid=TESTSET0002',
        named.join(' '));

    check('a request with no television still carries the package id',
        uris(pkcs10.distributor({ email: 'a@b.c', devices: [] }).csr).length === 1);

    check('two requests do not share a key',
        pkcs10.author({ name: 'x' }).key !== pkcs10.author({ name: 'x' }).key);
});
