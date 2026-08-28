'use strict';

// Reading a command line where some flags take a value.
//
// The naive read — anything not starting with a dash is a positional — puts a
// flag's value in the same slot as a TV address. `npm run mint -- --duid
// CPCLIM2YRW7DO` left mint believing the television lived at CPCLIM2YRW7DO,
// and its closing advice came out as
//
//     npm run certs -- CPCLIM2YRW7DO <pin>
//
// which is wrong in a way somebody would try. Harmless there. Not harmless in
// anything that decides what to contact from a positional, which is most of
// these tools.
//
// So the flags that take a value are declared, and their values stop being
// mistaken for arguments of their own.

/**
 * Splits argv into positionals and flags, knowing which flags consume the
 * token after them.
 *
 * Unknown flags are treated as boolean, which is the safe way round: a stray
 * `--verbose` costs nothing, while assuming an unknown flag eats the next
 * token would swallow the TV address.
 */
const parse = (argv, valued) => {
    const takesValue = valued || [];
    const positionals = [];
    const values = Object.create(null);
    const seen = [];

    for (let at = 0; at < argv.length; at += 1) {
        const token = argv[at];

        if (token[0] !== '-') {
            positionals.push(token);
            continue;
        }

        seen.push(token);

        if (takesValue.indexOf(token) !== -1) {
            // A flag left dangling at the end of the line has no value rather
            // than an undefined one, so callers passing it on cannot hand
            // `undefined` to a child process.
            values[token] = at + 1 < argv.length ? argv[at + 1] : null;
            at += 1;
        }
    }

    return {
        positionals,
        has: (flag) => seen.indexOf(flag) !== -1,
        value: (flag) => (flag in values ? values[flag] : null)
    };
};

module.exports = { parse };
