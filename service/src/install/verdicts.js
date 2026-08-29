'use strict';

// vd_appinstall's exit status does not survive an sdb shell stream, so the line it prints is the whole
// verdict. Adding a signature here is also what teaches `settled` to stop waiting for it.

const { ErrorCode } = require('../protocol.js');

const SUCCEEDED = 'spend time';

// Most specific first, since an author mismatch is also an `install failed` line. `remedy` names the
// package that has to go, which is not known until an install has failed.
const SIGNATURES = [
    {
        // app_id[…] install failed[118, -11], reason: Author certificate not match :
        code: ErrorCode.AUTHOR_MISMATCH,
        matches: /Author certificate not match/i,
        remedy: (context) => (context.replaceWith
            ? 'The copy already installed was signed by a different author certificate,\n' +
              'and Tizen will not update across that. Remove it and install fresh:\n\n' +
              `  ${context.replaceWith}`
            : 'A copy signed by somebody else is already installed, and Tizen will not ' +
              'update across a changed author. Remove ' +
              `${context.packageId || 'it'} from the TV's Apps menu` +
              `${context.packageId ? ` — or run \`vd_appuninstall ${context.packageId}\` in the shell tab` : ''}` +
              ' — then install again.')
    },
    {
        // Check certificate error : :Check config.xml — the stored pair does not cover this set.
        code: ErrorCode.CERT_REJECTED,
        matches: /Check certificate error/i,
        remedy: (context) => (context.replaceWith
            ? 'That package is signed for a different television, or not signed at all.\n' +
              '`npm run package` signs one for this machine\'s TV; `npm run package -- --unsigned`\n' +
              'does not, and a set refuses those over sdb.'
            : 'The stored certificates do not cover this television. They have been ' +
              'cleared, so send a fresh pair — `npm run certs -- <ip> <pin>`.')
    },
    {
        // install failed[118, -12] Invalid certificate chain with certificate in signature
        code: ErrorCode.CERT_CHAIN_INVALID,
        matches: /Invalid certificate chain/i,
        remedy: () => 'That package carries the stock Tizen distributor certificate, which no ' +
            'retail Samsung set accepts. It needs a Samsung pair — `npm run mint -- <ip>`.'
    },
    {
        // install failed[118, -22], reason: Security error : :Invalid function parameter was given:<2>
        code: ErrorCode.SECURITY_ERROR,
        matches: /Security error/i,
        remedy: () => 'Two things produce this and neither is the signature: a staged filename the ' +
            'installer will not take, or no device-profile.xml on the TV for the current ' +
            'certificate. Re-sending the pair with `npm run certs` writes both.'
    },
    {
        // MISMATCHED_PRIVILEGE_LEVEL - http://tizen.org/privilege/packagemanager.install
        //   >> Use at least platform signatured certificate.
        code: ErrorCode.PRIVILEGE_TOO_HIGH,
        matches: /MISMATCHED_PRIVILEGE_LEVEL/i,
        remedy: (context) => {
            const named = /(http:\/\/tizen\.org\/privilege\/\S+)/.exec(context.output || '');

            return `That package asks for ${named ? named[1] : 'a privilege'}, which only a ` +
                'platform-level certificate signs for. A public pair — which is all anybody ' +
                'can mint for themselves — cannot reach it, and nothing here can change that.';
        }
    },
    {
        // Anything else the installer refused. No remedy: the line itself is the only evidence.
        code: ErrorCode.INSTALL_FAILED,
        matches: /install failed/i,
        remedy: () => null
    }
];

const verdictLine = (text, matches) => text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => matches.test(line) || /install failed/i.test(line))[0] || text.trim().slice(-400);

const settled = (output) => {
    const text = output || '';

    return text.indexOf(SUCCEEDED) !== -1 || SIGNATURES.some((signature) => signature.matches.test(text));
};

const failureIn = (output, context) => {
    const text = output || '';
    const signature = SIGNATURES.filter((candidate) => candidate.matches.test(text))[0];

    if (!signature) return null;

    return {
        code: signature.code,
        line: verdictLine(text, signature.matches),
        remedy: signature.remedy(Object.assign({ output: text }, context || {}))
    };
};

// An empty string is not success: that once reported a failed install as a done one.
const interpret = (output, context) => {
    const text = output || '';
    const failure = failureIn(text, context);

    if (failure) {
        throw Object.assign(new Error(failure.line), { code: failure.code, remedy: failure.remedy });
    }

    if (text.indexOf(SUCCEEDED) === -1) {
        throw Object.assign(
            new Error('The installer reported neither success nor failure. ' +
                `Output: ${text.trim().slice(-400) || '(empty)'}`),
            { code: ErrorCode.INSTALL_FAILED, remedy: null }
        );
    }

    return { output: text };
};

module.exports = { interpret, failureIn, settled, verdictLine, SIGNATURES, SUCCEEDED };
