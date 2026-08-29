'use strict';

const memory = require('../src/obs/memory.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const denied = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };

const TIZEN = { memoryUsage: denied, resourceUsage: () => ({ maxRSS: 79608 }) };

const LAPTOP = { memoryUsage: () => ({ rss: 84 * 1000 * 1000 }), resourceUsage: () => ({ maxRSS: 100000 }) };

const MUTE = { memoryUsage: denied, resourceUsage: denied };

{
    const it = memory.sample(TIZEN);

    check('a denied /proc is a null rather than a throw', it.rss === null, JSON.stringify(it.rss));

    check('getrusage still gives a peak, in bytes rather than kilobytes',
        it.peakRss === 79608 * 1024, String(it.peakRss));

    check('the v8 heap answers without /proc',
        typeof it.heap === 'number' && it.heap > 0, String(it.heap));

    check('and carries the external bytes, which is where a Buffer lives',
        typeof it.external === 'number' && it.external >= 0, String(it.external));

    check('with no /proc, the comparable figure is heap plus external',
        memory.level(it) === it.heap + it.external, `${memory.level(it)}`);
}

{
    const it = memory.sample(LAPTOP);

    check('where rss is readable it is what gets compared',
        memory.level(it) === 84 * 1000 * 1000, String(memory.level(it)));

    check('and it is what the description leads with',
        /^84\.0 MB rss/.test(memory.describe(it)), memory.describe(it));
}

{
    const it = { rss: null, peakRss: null, heap: null, external: null, pss: null };

    check('a set that reports nothing says so rather than claiming zero',
        memory.level(it) === null && memory.describe(it) === 'unmeasurable', memory.describe(it));
}

{
    const it = memory.sample({ ...LAPTOP, lwnode: { PssUsage: () => 12345678 } });

    check('pss is preferred over rss when a runtime offers it',
        memory.level(it) === 12345678 && /pss/.test(memory.describe(it)), memory.describe(it));
}

{
    const held = memory.peak(TIZEN);

    held.at('probing');
    const big = [];
    for (let i = 0; i < 200; i += 1) big.push(Buffer.alloc(64 * 1024));
    held.at('resigning');

    const high = held.highest();

    check('the peak names the step it happened at',
        typeof high.at === 'string' && big.length === 200, JSON.stringify(high.at));

    check('and an unmeasurable run reports no step at all',
        memory.peak(MUTE).highest().at === null, JSON.stringify(memory.peak(MUTE).highest()));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
