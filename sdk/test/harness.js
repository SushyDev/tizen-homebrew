'use strict';

const suite = (name, body) => {
    const results = [];

    const check = (label, ok, detail) => {
        results.push(Boolean(ok));
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  <- ${detail === undefined ? '' : detail}`}`);
    };

    Promise.resolve()
        .then(() => body(check))
        .then(() => {
            const failed = results.filter((ok) => !ok).length;
            console.log(`\n${results.length - failed}/${results.length} checks passed.`);
            process.exit(failed ? 1 : 0);
        })
        .catch((error) => {
            console.error(`\n${name} harness error:`, error.message);
            process.exit(1);
        });
};

module.exports = { suite };
