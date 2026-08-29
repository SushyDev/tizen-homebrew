'use strict';

const forge = require('node-forge');

const Upstream = require('tizen/src/packageSigner.js');
const Vendored = require('../src/install/signature.js');
const { asPem } = require('../../tools/certificates.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const PASSWORD = 'test-password';

const mint = () => {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400000);

    const name = [{ name: 'commonName', value: 'test' }];
    cert.setSubject(name);
    cert.setIssuer(name);
    cert.setExtensions([{
        name: 'subjectAltName',
        altNames: [{ type: 6, value: 'URN:tizen:deviceid=TESTSET1234' }]
    }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSWORD);
    const der = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

    return {
        p12: forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der.toString('binary')), false, PASSWORD),
        pem: asPem(der, PASSWORD)
    };
};

const files = () => [
    { uri: 'config.xml', data: Buffer.from('<widget/>') },
    { uri: 'ui%2Fdist%2Findex.html', data: Buffer.from('<html>&amp; < > " \'</html>') },
    { uri: 'ui%2Fdist%2Ftheme.wav', data: Buffer.from([0, 1, 2, 255]) },
    { uri: 'service%2Fdist%2Findex.js', data: Buffer.from('a<b && c>d') },
    { uri: 'icon.png', data: Buffer.from('\u00ff\u00fe binary-ish') }
];

const main = async () => {
    const { p12, pem } = mint();

    for (const id of ['AuthorSignature', 'DistributorSignature']) {
        const theirs = await new Upstream(id, files()).sign(p12);
        const ours = await new Vendored(id, files()).sign(pem);

        const name = id === 'AuthorSignature' ? 'author-signature.xml' : 'signature1.xml';
        const xmlOf = (list) => list.find((file) => file.uri === name).data.toString('utf8');

        check(`${id} is byte-identical to the upstream signer`,
            xmlOf(theirs) === xmlOf(ours),
            `${xmlOf(theirs).length} vs ${xmlOf(ours).length} chars`);

        check(`${id} still unshifts itself into the file list`,
            ours.length === files().length + 1 && ours[0].uri === name, ours.map((f) => f.uri).join(', '));
    }

    {
        const pair = {
            certificates: ['-----BEGIN CERTIFICATE-----\nQUFB\n-----END CERTIFICATE-----\n',
                '-----BEGIN CERTIFICATE-----\nQkJC\n-----END CERTIFICATE-----\n'],
            key: pem.key
        };

        const signature = new Vendored('AuthorSignature', files());
        signature._addKeyInfo(pair);

        const at = [signature.keyInfo.indexOf('QUFB'), signature.keyInfo.indexOf('QkJC')];

        check('every certificate in a chain reaches the KeyInfo, in order',
            at[0] !== -1 && at[1] !== -1 && at[0] < at[1], signature.keyInfo);
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
