'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { createVerify, X509Certificate } = require('crypto');

const signing = require('../signing.js');
const pkcs12 = require('../pkcs12.js');
const signers = require('./fixtures/signers.js');
const { suite } = require('./harness.js');

const FIXTURES = join(__dirname, 'fixtures');

// The fixtures are what `tizen`'s own signer produced for this key and these files, kept so the
// comparison outlives the dependency it came from.
const golden = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const files = () => [
    { uri: 'config.xml', data: Buffer.from('<widget/>') },
    { uri: 'ui%2Fdist%2Findex.html', data: Buffer.from('<html>&amp; < > " \'</html>') },
    { uri: 'ui%2Fdist%2Ftheme.wav', data: Buffer.from([0, 1, 2, 255]) },
    { uri: 'service%2Fdist%2Findex.js', data: Buffer.from('a<b && c>d') },
    { uri: 'icon.png', data: Buffer.from('\u00ff\u00fe binary-ish') }
];

const verifies = (xml) => {
    const info = `${/(<SignedInfo>[\s\S]*?<\/SignedInfo>)/.exec(xml)[1]}\n`;
    const value = /<SignatureValue>([\s\S]*?)<\/SignatureValue>/.exec(xml)[1].replace(/\s/g, '');
    const body = /<X509Certificate>([\s\S]*?)<\/X509Certificate>/.exec(xml)[1].trim();

    return createVerify('RSA-SHA512')
        .update(signing.canonicalise(info))
        .verify(new X509Certificate(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`).publicKey,
            Buffer.from(value, 'base64'));
};

suite('signing', (check) => {
    const pair = pkcs12.read(signers.forgeSigner(), signers.FORGE_PASSWORD);

    const author = signing.signature('AuthorSignature', files(), pair);

    check('the author signature is byte-for-byte what Tizen Studio\'s signer wrote',
        author.data.toString('utf8') === golden('author-signature.xml'),
        `${author.data.length} against ${golden('author-signature.xml').length} bytes`);

    const authored = [author, ...files()];
    const distributor = signing.signature('DistributorSignature', authored, pair);

    check('the distributor signature is byte-for-byte the same',
        distributor.data.toString('utf8') === golden('signature1.xml'),
        `${distributor.data.length} against ${golden('signature1.xml').length} bytes`);

    check('the author signature verifies against its own certificate', verifies(author.data.toString('utf8')));
    check('the distributor signature verifies too', verifies(distributor.data.toString('utf8')));

    const both = signing.sign(files(), { author: pair, distributor: pair });

    check('signing puts the distributor first, then the author, then the files',
        both.map((file) => file.uri).join(',')
            === `signature1.xml,author-signature.xml,${files().map((file) => file.uri).join(',')}`,
        both.map((file) => file.uri).join(','));

    check('the list it was handed is left alone', (() => {
        const original = files();
        signing.sign(original, { author: pair, distributor: pair });

        return original.length === 5;
    })());

    check('every certificate in the chain reaches the signature',
        (both[0].data.toString('utf8').match(/<X509Certificate>/g) || []).length === pair.certificates.length);

    check('changing one byte of one file changes the signature',
        signing.signature('AuthorSignature',
            files().map((file, index) => (index === 0 ? { ...file, data: Buffer.from('<widget />') } : file)),
            pair).data.toString('utf8') !== author.data.toString('utf8'));
});
