'use strict';

// The naive read puts a flag's value in the same slot as a positional: `--duid CPCLIM2YRW7DO` left
// mint believing the television lived at CPCLIM2YRW7DO. Unknown flags stay boolean, which is the
// safe way round.
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
