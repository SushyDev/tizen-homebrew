'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const x509 = require('../x509.js');
const authority = require('../authority.js');
const { suite } = require('./harness.js');

const signer = readFileSync(join(__dirname, 'fixtures', 'forge-signer.pem'), 'utf8');
const leaf = `${signer.split('-----END CERTIFICATE-----')[0]}-----END CERTIFICATE-----\n`;

suite('x509', (check) => {
    check('the televisions a certificate names are read out of it',
        x509.devicesIn(leaf).join(',') === 'TESTSET0001,TESTSET0002', x509.devicesIn(leaf).join(','));

    check('a television is only named once',
        x509.devicesIn([leaf, leaf]).length === 2);

    check('a certificate that names none reads as none',
        x509.devicesIn(authority.authorCa()).length === 0);

    const described = x509.describe(leaf);

    check('the common name is read', described.subject === 'tizen-homebrew test signer', described.subject);
    check('the validity window is read', described.until.getUTCFullYear() === 2040, String(described.until));
    check('an expiry is counted in days', x509.expiresIn(leaf) > 0, x509.expiresIn(leaf));

    check('something that is not a certificate reads as nothing',
        x509.describe('not a certificate') === null);

    check('the bundled authorities parse', (() => {
        const author = x509.describe(authority.authorCa());
        const partner = x509.describe(authority.distributorCa('Partner'));
        const open = x509.describe(authority.distributorCa('Public'));

        return author.subject === 'Samsung VD Author CA'
            && partner.subject === 'VD DEVELOPER Partner CA Class'
            && open.subject === 'VD DEVELOPER Public CA Class';
    })());

    check('the bundled authorities have not expired',
        [authority.authorCa(), authority.distributorCa('Partner'), authority.distributorCa('Public')]
            .every((pem) => x509.expiresIn(pem) > 0));

    check('an unknown privilege level is named in the error', (() => {
        try {
            authority.distributorCa('Platform');
            return false;
        } catch (error) {
            return /Platform/.test(error.message);
        }
    })());
});
