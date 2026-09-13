'use strict';

// Samsung's VD certificate authority: the same three endpoints the Samsung Certificate Extension
// posts to, including `/apis/v1/distributors`, which upstream lost when the domain moved.

const { randomBytes } = require('crypto');

const pkcs10 = require('./pkcs10.js');
const pkcs12 = require('./pkcs12.js');
const authority = require('./authority.js');

const HOST = 'https://svdca.samsungqbe.com';

const ENDPOINTS = {
    author: `${HOST}/apis/v3/authors`,
    distributor: `${HOST}/apis/v3/distributors`,
    profile: `${HOST}/apis/v1/distributors`
};

const TIMEOUT_MS = 30000;
const ATTEMPTS = 3;

const friendly = (message) => Object.assign(new Error(message), { isFriendly: true, code: 'samsungRefused' });

const line = (text) => Buffer.from(`${text}\r\n`, 'utf8');

const part = (boundary, headers, value) => Buffer.concat([
    line(`--${boundary}`),
    ...headers.map(line),
    line(''),
    Buffer.from(value, 'utf8'),
    line('')
]);

const multipart = (fields, upload) => {
    const boundary = `----tizenhomebrew${randomBytes(16).toString('hex')}`;

    const body = Buffer.concat([
        ...Object.keys(fields).map((name) => part(
            boundary,
            [`Content-Disposition: form-data; name="${name}"`],
            String(fields[name])
        )),
        part(
            boundary,
            [
                `Content-Disposition: form-data; name="csr"; filename="${upload.filename}"`,
                'Content-Type: application/octet-stream'
            ],
            upload.value
        ),
        line(`--${boundary}--`)
    ]);

    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

// Samsung answers a refusal as JSON; anything else is passed through as it arrived.
const complaint = (status, text) => {
    const parsed = (() => {
        try {
            return JSON.parse(text);
        } catch (error) {
            return null;
        }
    })();

    const described = parsed && parsed.error && parsed.error.description;

    if (described && /accesstoken|userid/i.test(described)) {
        return `${described}\n\n  The sign-in expired — run this again and sign in when the browser opens.`;
    }

    return described || `${status} ${String(text).trim().slice(0, 300) || 'no answer'}`;
};

// Only a request that never reached Samsung is sent again: a certificate that was issued and lost
// on the way back is a certificate that exists, and asking twice would quietly mint a second one.
const post = async (url, fields, upload, attempt) => {
    const { body, contentType } = multipart(fields, upload);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': String(body.length) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    }).catch((error) => {
        if ((attempt || 1) >= ATTEMPTS) {
            throw friendly(`Could not reach ${new URL(url).host} — ${error.message}`);
        }

        return null;
    });

    if (!response) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt || 1)));

        return post(url, fields, upload, (attempt || 1) + 1);
    }

    const text = await response.text();

    if (!response.ok) throw friendly(`Samsung refused the request:\n\n  ${complaint(response.status, text)}`);

    return text;
};

const account = (access) => ({
    access_token: access.accessToken,
    user_id: access.userId,
    platform: 'VD'
});

const authorCertificate = (access, csr) => post(
    ENDPOINTS.author,
    account(access),
    { filename: 'author.csr', value: csr }
);

const distributorFields = (access, level) => ({
    ...account(access),
    privilege_level: level,
    developer_type: 'Individual'
});

const distributorCertificate = (access, level, csr) => post(
    ENDPOINTS.distributor,
    distributorFields(access, level),
    { filename: 'distributor.csr', value: csr }
);

// The profile is what Tizen Studio stages on the set. If the endpoint has gone the way of the old
// domain it answers with the certificate instead, and that is what has been staged until now.
const deviceProfile = async (access, level, csr, certificate) => {
    const answer = await post(
        ENDPOINTS.profile,
        distributorFields(access, level),
        { filename: 'distributor.csr', value: csr }
    ).catch(() => null);

    return answer && answer.trim().startsWith('<') && !answer.includes('BEGIN CERTIFICATE')
        ? { profile: answer, from: 'samsung' }
        : { profile: certificate, from: 'certificate' };
};

const authorPair = async (access, { name, password }) => {
    const request = pkcs10.author({ name });
    const issued = await authorCertificate(access, request.csr);

    return {
        p12: pkcs12.write({
            certificates: [issued, authority.authorCa()],
            key: request.key,
            password
        }),
        certificates: [issued, authority.authorCa()],
        key: request.key
    };
};

const distributorPair = async (access, { email, password, level, devices }) => {
    const request = pkcs10.distributor({ email, devices });
    const issued = await distributorCertificate(access, level, request.csr);
    const staged = await deviceProfile(access, level, request.csr, issued);

    const certificates = [issued, authority.distributorCa(level)];

    return {
        p12: pkcs12.write({ certificates, key: request.key, password }),
        certificates,
        key: request.key,
        certificate: issued,
        profile: staged.profile,
        profileFrom: staged.from,
        devices
    };
};

module.exports = { authorPair, distributorPair, ENDPOINTS, HOST, multipart, complaint };
