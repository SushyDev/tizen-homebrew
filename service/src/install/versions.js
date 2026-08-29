'use strict';

// Anchored on purpose: `1.2.0 (beta)` is not a version, and reading it as 1.2.0 would invent a fact.
const PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const NUMERIC = /^\d+$/;

const parse = (value) => {
    const found = PATTERN.exec(String(value === null || value === undefined ? '' : value).trim());

    if (!found) return null;

    return {
        release: [Number(found[1]), Number(found[2] || 0), Number(found[3] || 0)],
        prerelease: found[4] ? found[4].split('.') : []
    };
};

const clean = (value) => (parse(value) ? String(value).trim().replace(/^v/i, '') : null);

// Semver's rule for the tail: numeric identifiers compare as numbers, so rc.2 comes before rc.10.
const comparePrerelease = (left, right) => {
    // Having a prerelease at all is what loses: 1.2.0-rc1 comes before 1.2.0.
    if (!left.length || !right.length) {
        if (left.length === right.length) return 0;
        return left.length ? -1 : 1;
    }

    for (let at = 0; at < Math.max(left.length, right.length); at++) {
        const a = left[at];
        const b = right[at];

        if (a === undefined) return -1;
        if (b === undefined) return 1;
        if (a === b) continue;

        const leftNumeric = NUMERIC.test(a);
        const rightNumeric = NUMERIC.test(b);

        if (leftNumeric && rightNumeric) return Number(a) < Number(b) ? -1 : 1;

        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;

        return a < b ? -1 : 1;
    }

    return 0;
};

const compare = (left, right) => {
    const a = parse(left);
    const b = parse(right);

    // null is "cannot say", which is a different answer from "the same".
    if (!a || !b) return null;

    for (let at = 0; at < 3; at++) {
        if (a.release[at] !== b.release[at]) return a.release[at] < b.release[at] ? -1 : 1;
    }

    return comparePrerelease(a.prerelease, b.prerelease);
};

const isNewer = (candidate, current) => compare(candidate, current) === 1;

module.exports = { parse, clean, compare, isNewer };
