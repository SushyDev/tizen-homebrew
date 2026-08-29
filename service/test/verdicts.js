'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const { interpret, failureIn, settled, SIGNATURES } = require('../src/install/verdicts.js');
const { ErrorCode } = require('../src/protocol.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const read = (output, context) => {
    try {
        interpret(output, context);
        return { code: null, remedy: null, message: null };
    } catch (error) {
        return { code: error.code, remedy: error.remedy, message: error.message };
    }
};

const SUCCESS = 'coreinstall spend time = 1234 ms';

{
    const line = 'app_id[tUb3Xq7Lm9] install failed[118, -11], reason: Author certificate not match :';
    const seen = read(line, { packageId: 'tUb3Xq7Lm9' });

    check('an author mismatch is not just "install failed"',
        seen.code === ErrorCode.AUTHOR_MISMATCH, String(seen.code));

    check('the television\'s own line survives verbatim',
        seen.message === line, seen.message);

    check('the remedy names the package that has to go',
        /tUb3Xq7Lm9/.test(seen.remedy) && /vd_appuninstall/.test(seen.remedy), String(seen.remedy));

    const fromBootstrap = read(line, { packageId: 'GJBBYNLkgP', replaceWith: 'npm run bootstrap -- 1.2.3.4 --replace' });

    check('and names the command instead when bootstrap is asking',
        /npm run bootstrap -- 1\.2\.3\.4 --replace/.test(fromBootstrap.remedy), String(fromBootstrap.remedy));

    check('an unrecognised verdict gets no invented advice',
        read('app_id[x] install failed[118, -14]').remedy === null,
        String(read('app_id[x] install failed[118, -14]').remedy));
}

{
    const cases = [
        ['Check certificate error : :Check config.xml', ErrorCode.CERT_REJECTED],
        ['install failed[118, -12] Invalid certificate chain with certificate in signature', ErrorCode.CERT_CHAIN_INVALID],
        ['install failed[118, -22], reason: Security error : :Invalid function parameter was given:<2>', ErrorCode.SECURITY_ERROR],
        ['MISMATCHED_PRIVILEGE_LEVEL - http://tizen.org/privilege/packagemanager.install', ErrorCode.PRIVILEGE_TOO_HIGH],
        ['app_id[x] install failed[118, -14]', ErrorCode.INSTALL_FAILED]
    ];

    cases.forEach(([output, expected]) => {
        check(`"${output.slice(0, 44)}…" reads as ${expected}`,
            read(output).code === expected, String(read(output).code));
    });

    check('a privilege refusal quotes the privilege it wanted',
        /packagemanager\.install/.test(read(cases[3][0]).remedy), String(read(cases[3][0]).remedy));
}

{
    check('a successful install is not a failure', read(SUCCESS).code === null, String(read(SUCCESS).code));

    check('silence is not success either',
        read('').code === ErrorCode.INSTALL_FAILED, String(read('').code));

    check('but silence is not a verdict, which is what bootstrap needs',
        failureIn('') === null, JSON.stringify(failureIn('')));
}

{
    const samples = [
        'app_id[x] install failed[118, -11], reason: Author certificate not match :',
        'Check certificate error : :Check config.xml',
        'install failed[118, -12] Invalid certificate chain with certificate in signature',
        'install failed[118, -22], reason: Security error :',
        'MISMATCHED_PRIVILEGE_LEVEL - http://tizen.org/privilege/packagemanager.install',
        'app_id[x] install failed[118, -14]'
    ];

    check('every verdict is one the installer stops waiting for',
        samples.every(settled), samples.filter((s) => !settled(s)).join(' | '));

    check('and success is too', settled(SUCCESS), 'success did not settle');

    check('half a line settles nothing',
        settled('...installing') === false, 'stopped waiting too early');
}

{
    const codes = Object.keys(ErrorCode).map((key) => ErrorCode[key]);

    check('every signature names a code the protocol declares',
        SIGNATURES.every((signature) => codes.indexOf(signature.code) !== -1),
        SIGNATURES.filter((s) => codes.indexOf(s.code) === -1).map((s) => s.code).join(', '));

    const ui = readFileSync(join(__dirname, '../../ui/src/main.js'), 'utf8');
    const table = /const EXPLANATIONS = \{([\s\S]*?)\n\};/.exec(ui);
    const explained = table ? (table[1].match(/^\s{4}(\w+):/gm) || []).map((line) => line.trim().replace(':', '')) : [];
    const missing = codes.filter((code) => explained.indexOf(code) === -1);

    check('and every code the service can send has a string on the phone',
        table !== null && missing.length === 0,
        table ? `no explanation for: ${missing.join(', ')}` : 'could not find EXPLANATIONS in ui/src/main.js');
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
