'use strict';

// The log, which is now a surface people read rather than a debugging aid: it
// is what the television shows on its own screen and what a phone reads over
// the network. So the things it promises are tested — the ring stays bounded,
// a poller never sees a line twice, and nothing a caller hands it can take the
// service down.

const { startRecording, format, Facility } = require('../src/obs/log.js');
const units = require('../src/obs/units.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

// A recorder that neither prints into this suite's output nor records the
// suite's own console.log calls as if they were service events.
const quietly = (options) => {
    const printed = [];
    const recorder = startRecording({ capture: false, print: (line) => printed.push(line), ...options });

    return { ...recorder, printed };
};

{
    const recorder = quietly({ max: 10 });

    recorder.log.info(Facility.SVC, 'first');
    recorder.log.warn(Facility.DEV, 'second');
    recorder.log.err(Facility.PKG, 'third');

    const lines = recorder.since(0);

    check('every line is kept, in order', lines.length === 3 && lines[0].text === 'first',
        JSON.stringify(lines.map((line) => line.text)));

    check('each carries a facility and a severity',
        lines[1].facility === 'dev' && lines[1].level === 'warn', JSON.stringify(lines[1]));

    check('the clock is monotonic', lines[0].t <= lines[1].t && lines[1].t <= lines[2].t,
        lines.map((line) => line.t).join(' '));

    check('a poller is never handed the same line twice',
        recorder.since(lines[2].seq).length === 0, 'since(last) returned something');

    check('severities can be counted without reading them',
        recorder.counts().warn === 1 && recorder.counts().err === 1, JSON.stringify(recorder.counts()));

    check('every line is printed as well as kept',
        recorder.printed.length === 3, `printed ${recorder.printed.length}`);

    // The ring is what stops a service failing in a loop from filling the
    // television's memory with its own complaints.
    for (let i = 0; i < 50; i++) recorder.log.info(Facility.SVC, `line ${i}`);

    const bounded = recorder.since(0);

    check('the ring is bounded', bounded.length === 10, `kept ${bounded.length}`);
    check('and it keeps the newest', bounded[bounded.length - 1].text === 'line 49',
        bounded[bounded.length - 1].text);
}

// One record is one line, which is the promise the whole log is built on and
// the one a stack trace used to break. The television counts log rows to find
// how many fit on screen; a record eight lines tall made that count oscillate
// and recursed the page until the stack ran out — pressing `show logs` killed
// the app. See `fit` in ui/src/tv.js.
{
    const recorder = quietly({});

    recorder.log.err(Facility.SVC, 'uncaught exception: TypeError: app.onRequest is not a function\n' +
        '    at MessagePort.<anonymous> (/usr/share/wrt/app/service/service_runner.js:152:59)\n' +
        '    at MessagePort.emit (events.js:310:20)');

    const lines = recorder.since(0);

    check('a stack trace becomes one record per line', lines.length === 3,
        `kept ${lines.length}`);

    check('and no record has a newline left in it',
        lines.every((line) => line.text.indexOf('\n') === -1),
        JSON.stringify(lines.map((line) => line.text)));

    check('each line keeps the severity and facility of the message it came from',
        lines.every((line) => line.level === 'err' && line.facility === Facility.SVC),
        JSON.stringify(lines.map((line) => [line.facility, line.level])));

    check('a poller can still resume from any of them',
        recorder.since(lines[0].seq).length === 2, 'since(first) did not return the rest');

    check('and every one of them is printed', recorder.printed.length === 3,
        `printed ${recorder.printed.length}`);
}

// A message that simply ends in a newline is one line, not two: the newline is
// punctuation on the message rather than an empty line somebody wrote.
{
    const recorder = quietly({});
    recorder.log.info(Facility.SVC, 'coreinstall spend time = 1234 ms\n');

    check('a trailing newline does not add an empty record', recorder.since(0).length === 1,
        JSON.stringify(recorder.since(0).map((line) => line.text)));
}

// Debug is the level the TV page's own polling logs at: on by request only,
// because recording it means every poll produces a line the next poll
// delivers — a log that grows because it is being read.
{
    const off = quietly({ debug: false });
    off.log.debug(Facility.HTTP, 'a poll');
    off.log.info(Facility.HTTP, 'a request');

    const on = quietly({ debug: true });
    on.log.debug(Facility.HTTP, 'a poll');

    check('debug lines are dropped unless asked for', off.since(0).length === 1, JSON.stringify(off.since(0)));
    check('and kept when they are', on.since(0).length === 1, JSON.stringify(on.since(0)));
}

// Nothing else in the service knows this file exists, and it still has to
// catch what they print.
{
    const recorder = quietly({ capture: true });

    console.log('a dependency said something');
    const captured = recorder.since(0).filter((line) => line.text === 'a dependency said something');

    check('an ordinary console.log is still recorded',
        captured.length === 1 && captured[0].facility === Facility.SVC, JSON.stringify(captured));
}

// Tizen reloads the service into the same process on a reinstall, so this
// module gets a second life beside the first. The console must end up wrapped
// once and feeding the newest recorder — not wrapped twice, feeding a ring
// that nobody can reach any more.
{
    const first = quietly({ capture: true });
    const wrapper = console.log;

    const second = quietly({ capture: true });

    check('a reload does not stack another console wrapper', console.log === wrapper,
        'console.log was replaced a second time');

    console.log('after the reload');

    const inFirst = first.since(0).filter((line) => line.text === 'after the reload').length;
    const inSecond = second.since(0).filter((line) => line.text === 'after the reload').length;

    check('and the newest recorder takes the console over', inSecond === 1 && inFirst === 0,
        `first kept ${inFirst}, second kept ${inSecond}`);
}

// A log call must never be the reason something fails.
{
    const recorder = quietly({});
    let survived = true;

    try {
        const circular = {};
        circular.self = circular;
        recorder.log.info(Facility.SVC, circular, undefined, null);
    } catch (e) {
        survived = false;
    }

    check('an unprintable value does not throw', survived, 'a log call threw');
}

check('the printed line is dmesg\'s',
    /^\[\s+12\.345678\] pkg: staged 5\.44 MB$/.test(format({ t: 12345.678, facility: 'pkg', text: 'staged 5.44 MB' })),
    format({ t: 12345.678, facility: 'pkg', text: 'staged 5.44 MB' }));

// The units the log reports in. Wrong here means a size or a duration reads as
// a different order of magnitude on a screen nobody can check it against.
check('sizes are decimal and three figures', units.size(5438912) === '5.44 MB' && units.size(512) === '512 B',
    `${units.size(5438912)} / ${units.size(512)}`);

check('durations change unit at a second', units.took(310) === '310ms' && units.took(4190) === '4.19s',
    `${units.took(310)} / ${units.took(4190)}`);

check('a mapped IPv4 address reads as itself', units.host('::ffff:192.168.2.31') === '192.168.2.31',
    units.host('::ffff:192.168.2.31'));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
