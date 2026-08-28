'use strict';

// Numbers, written the way a log should write them.
//
// Two rules, both borrowed from every Unix tool that reports a transfer.
//
// Sizes are decimal, because that is what the thing being measured is
// measured in: a release asset's Content-Length, a package limit, the bytes
// vd_appinstall says it wrote. Rendering 5,438,912 as "5.2 MiB" is arguably
// more correct and definitely less useful when the next line quotes the same
// number in a different unit.
//
// Durations change unit at one second in each direction, because a reader
// comparing "310ms" with "4.19s" has to do arithmetic to see which is bigger,
// and one comparing "0.31s" with "4.19s" does not.

const KILO = 1000;
const UNITS = ['B', 'kB', 'MB', 'GB'];

/** A byte count at three significant figures, e.g. `5.44 MB`. */
const size = (count) => {
    const value = Number(count) || 0;

    if (value < KILO) return `${Math.round(value)} B`;

    let scaled = value;
    let unit = 0;

    while (scaled >= KILO && unit < UNITS.length - 1) {
        scaled /= KILO;
        unit += 1;
    }

    return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${UNITS[unit]}`;
};

/** A duration in milliseconds, as `310ms` or `4.19s`. */
const took = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);

    return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
};

/** A transfer rate, given bytes and the milliseconds they took. */
const rate = (bytes, milliseconds) => (milliseconds > 0
    ? `${size((Number(bytes) || 0) / (milliseconds / 1000))}/s`
    : 'instantly');

/**
 * An address as a log should print it.
 *
 * Node reports IPv4 over a dual-stack socket as `::ffff:192.168.2.31`, which
 * is correct and unreadable — and makes the same phone look like two clients
 * depending on which socket it arrived on.
 */
const host = (address) => {
    const text = String(address || '');

    if (text.indexOf('::ffff:') === 0) return text.slice(7);
    if (text === '::1') return '127.0.0.1';

    return text || 'unknown';
};

module.exports = { size, took, rate, host };
