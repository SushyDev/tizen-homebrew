'use strict';

// What the television said about a package, and what to do about it.
//
// vd_appinstall's exit status is not available over an sdb shell stream, so
// the line it prints is the entire verdict. Reading that line used to happen
// twice — here for the phone, and again in tools/bootstrap.js for a terminal —
// and the two had drifted: bootstrap explained an author mismatch in four
// lines and named the command that fixes it, while the phone showed the raw
// text under "The TV rejected the install", which is true and useless.
//
// So the signatures live in one table. Each carries the stable code clients
// switch on and the sentence saying what to do about it, and both readers get
// the same answer.
//
// Adding a signature here is also what teaches `settled` to stop waiting for
// it. Those were two separate lists before, so a verdict could be perfectly
// understood and still sit there until the install timed out three minutes
// later — which is how "Check certificate error" behaved until somebody
// remembered to add it in both places.

const { ErrorCode } = require('../protocol.js');

// The one thing vd_appinstall says when it worked. It keeps its stream open
// afterwards, so this is what completion looks like — not the stream closing.
const SUCCEEDED = 'spend time';

/**
 * Every failure this project has actually seen from a television, most
 * specific first. An author mismatch is also an `install failed` line, so the
 * generic entry has to come last or it would answer for all of them.
 *
 * `remedy` is the part that could not live in the UI's own table of strings:
 * it names the package that has to go, or the command that puts it right, and
 * neither is known until an install has failed. It is given the context its
 * caller had — a package id here, an address in bootstrap — plus the output
 * itself, for the two verdicts that carry a detail worth reading back out.
 */
const SIGNATURES = [
    {
        // app_id[tUb3Xq7Lm9] install failed[118, -11], reason: Author certificate not match :
        //
        // Tizen will not *update* an app whose author certificate changed, and
        // re-signing cannot help: it sets the author to this television's own
        // pair, which is precisely the certificate the installed copy was not
        // signed with. The copy already there has to go first.
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
        // Check certificate error : :Check config.xml
        //
        // The stored pair does not cover this set, most often because it was
        // minted against a model name rather than the DUID — both are thirteen
        // anonymous characters. pipeline.js drops the pair when it sees this,
        // so the next attempt re-mints instead of failing identically.
        code: ErrorCode.CERT_REJECTED,
        matches: /Check certificate error/i,
        // Two readers, two causes. The service re-signed the package itself, so
        // the pair it holds is the suspect and it clears it. bootstrap installed
        // whatever is in release/, so the package's own signature is — and
        // saying "they have been cleared" there names something nothing did.
        remedy: (context) => (context.replaceWith
            ? 'That package is signed for a different television, or not signed at all.\n' +
              '`npm run package` signs one for this machine\'s TV; `npm run package -- --unsigned`\n' +
              'does not, and a set refuses those over sdb.'
            : 'The stored certificates do not cover this television. They have been ' +
              'cleared, so send a fresh pair — `npm run certs -- <ip> <pin>`.')
    },
    {
        // install failed[118, -12] Invalid certificate chain with certificate
        // in signature
        //
        // The distributor half is the stock Tizen public signer: a Tizen Test
        // CA certificate that expired in October 2022 and that a retail set
        // never trusted in the first place. See tools/package.js, which exists
        // partly to stop this being produced.
        code: ErrorCode.CERT_CHAIN_INVALID,
        matches: /Invalid certificate chain/i,
        remedy: () => 'That package carries the stock Tizen distributor certificate, which no ' +
            'retail Samsung set accepts. It needs a Samsung pair — `npm run mint -- <ip>`.'
    },
    {
        // install failed[118, -22], reason: Security error :
        //   :Invalid function parameter was given:<2>
        //
        // Reads like the certificate and usually is not. <2> is vd_appinstall's
        // second argument, the path, so a staged filename it dislikes produces
        // this; the other cause is no device-profile.xml on the TV for the
        // current pair. A set another tool has configured already has one,
        // which is why everything works until the certificate changes.
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
        // Anything else the installer refused. No remedy, because inventing
        // advice for a verdict nobody has seen before is worse than none: the
        // line itself is the only evidence there is.
        code: ErrorCode.INSTALL_FAILED,
        matches: /install failed/i,
        remedy: () => null
    }
];

/**
 * The television's own words, which is what goes in the log and under the
 * message on the phone.
 *
 * Verbatim, always. It is the one sentence saying what the *television*
 * thought of the package, and paraphrasing it has cost hours before now.
 */
const verdictLine = (text, matches) => text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => matches.test(line) || /install failed/i.test(line))[0] || text.trim().slice(-400);

/** True once the television has said something conclusive, either way. */
const settled = (output) => {
    const text = output || '';

    return text.indexOf(SUCCEEDED) !== -1 || SIGNATURES.some((signature) => signature.matches.test(text));
};

/**
 * The failure the television reported, or null if it did not report one.
 *
 * Null is not success. tools/bootstrap.js confirms against the TV's own
 * application registry precisely because some firmware answers a shell command
 * with nothing at all — `interpret` adds the stricter reading for the service,
 * which has no registry to ask and no second chance to ask it.
 */
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

/**
 * Reads a verdict out of vd_appinstall's output, or throws what it means.
 *
 * An empty string is not success. That distinction matters: treating "no error
 * seen" as "installed" once let a failed install be reported as a done one.
 */
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
