'use strict';

const samsung = require('../samsung.js');
const { suite } = require('./harness.js');

suite('samsung', (check) => {
    const { body, contentType } = samsung.multipart(
        { access_token: 'tok', user_id: 'uid', platform: 'VD' },
        { filename: 'author.csr', value: 'CSR-BODY' }
    );

    const text = body.toString('utf8');
    const boundary = /boundary=(.+)$/.exec(contentType)[1];

    check('the boundary in the header is the boundary in the body',
        text.indexOf(`--${boundary}\r\n`) === 0 && text.endsWith(`--${boundary}--\r\n`));

    check('every field arrives with its own disposition',
        ['access_token', 'user_id', 'platform']
            .every((name) => text.indexOf(`Content-Disposition: form-data; name="${name}"\r\n\r\n`) !== -1));

    check('the request is sent as a file, as the certificate authority expects',
        text.indexOf('Content-Disposition: form-data; name="csr"; filename="author.csr"\r\n' +
            'Content-Type: application/octet-stream\r\n\r\nCSR-BODY') !== -1);

    check('lines are terminated the way multipart wants them',
        text.split('\n').every((line) => line === '' || line.endsWith('\r')));

    check('two requests do not share a boundary',
        samsung.multipart({}, { filename: 'a', value: 'b' }).contentType
            !== samsung.multipart({}, { filename: 'a', value: 'b' }).contentType);

    check('a refusal is read out of the JSON Samsung sends',
        samsung.complaint(401, JSON.stringify({
            error: { status: 401, code: '301', description: 'Either userid or accesstoken is incorrect.' }
        })).indexOf('sign-in expired') !== -1);

    check('a refusal that is not about the token is passed through',
        samsung.complaint(400, JSON.stringify({ error: { description: 'The DUID format is wrong.' } }))
            === 'The DUID format is wrong.');

    check('a refusal that is not JSON still says something',
        samsung.complaint(503, '<html>gateway</html>').indexOf('503') === 0);

    check('the certificate endpoints are the ones the Samsung extension posts to',
        samsung.ENDPOINTS.author === 'https://svdca.samsungqbe.com/apis/v3/authors'
            && samsung.ENDPOINTS.distributor === 'https://svdca.samsungqbe.com/apis/v3/distributors'
            && samsung.ENDPOINTS.profile === 'https://svdca.samsungqbe.com/apis/v1/distributors');
});
