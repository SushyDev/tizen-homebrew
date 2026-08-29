'use strict';

// The developer REPL, which only ever runs where it cannot be tested by hand.
//
// Nothing here needs a television; what is being pinned is that a line behaves
// the way a prompt should, and that a line which throws comes back as an answer
// rather than as a dead service.

const { createRepl } = require('../src/dev/repl.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const store = { value: 41 };
const repl = createRepl({ store, answer: () => Promise.resolve('later') });

const main = async () => {
    {
        const it = await repl.evaluate('1 + 1');
        check('an expression comes back as its value', it.ok && it.value === '2', JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('store.value + 1');
        check('the context is in scope by name', it.ok && it.value === '42', JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('await answer()');
        check('await works, because every line is an async function',
            it.ok && it.value === "'later'", JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('let n = 0; for (const c of "tizen") n += 1; n');
        check('statements followed by an expression answer with the expression',
            it.ok && it.value === '5', JSON.stringify(it));
    }

    {
        // The semicolons in a for-header are what the split gets wrong, so the
        // fallback has to leave the source alone rather than mangle it.
        const it = await repl.evaluate('let t = 0; for (let i = 0; i < 4; i += 1) t += i;');
        check('a for-header is not mistaken for a trailing expression',
            it.ok && it.value === 'undefined', JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('store.value = 1; store.value');
        check('state changes stick, which is the point of a repl',
            it.ok && it.value === '1' && store.value === 1, JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('nope.missing');
        check('a throw is an answer, not a crash',
            !it.ok && /nope is not defined/.test(it.error), JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('this is not javascript');
        check('unparseable input says so', !it.ok && /Could not compile/.test(it.error), JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('   ');
        check('an empty line is refused rather than evaluated',
            !it.ok && /Nothing to evaluate/.test(it.error), JSON.stringify(it));
    }

    {
        const it = await repl.evaluate('"x".repeat(40000)');
        check('a huge value is truncated rather than sent whole',
            it.ok && it.value.length < 20000 && /more characters$/.test(it.value),
            `${it.value.length} characters`);
    }

    {
        const it = await repl.evaluate('Object.keys($).sort().join(",")');
        check('$ is the scope itself, so a prompt can ask what it can reach',
            it.ok && it.value === "'$,answer,store'", JSON.stringify(it));
    }

    {
        // Node has one; lwnode is built without. Either answer is correct, and
        // the failure has to name which it was.
        const opened = repl.openInspector(0);
        check('the inspector is offered or explained, never thrown',
            (opened.ok && typeof opened.url === 'string') || (!opened.ok && opened.error.length > 0),
            JSON.stringify(opened));
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('\nHarness error:', error.message);
    process.exit(1);
});
