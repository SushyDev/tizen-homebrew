'use strict';

// Which of two versions is the newer.
//
// One question is asked of this: whether what a catalogue app has released is
// ahead of the copy already on the television, which is the difference between
// a row that says "install" and one that says "update". Being wrong one way
// offers a downgrade; being wrong the other hides an update that exists, and
// that is the worse half — Tizen Homebrew is in its own catalogue precisely so
// a set can carry its own next version to itself, and it can only do that if
// it notices.
//
// So: semver, as far as the two things being compared can carry it. A Tizen
// widget version is MAJOR.MINOR.PATCH and nothing else; a release tag is
// whatever somebody typed — `v1.2.0`, `1.2`, `1.2.0-rc1`, `1.2.0+ci.4`. The
// two rules that are easy to get wrong by hand are the ones worth having code
// for: build metadata takes no part in the comparison, and a prerelease always
// loses to the release it precedes.

// Anchored on purpose: a version is the whole string or it is not a version.
// `1.2.0 (beta)` is not one, and reading it as 1.2.0 would be inventing a fact
// about somebody's release.
const PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const NUMERIC = /^\d+$/;

/**
 * Reads a version into `{ release, prerelease }`, or null for anything that is
 * not one.
 *
 * A missing minor or patch is zero, so `1.2` and `1.2.0` are the same version
 * — which is what somebody who tagged `v1.2` meant.
 */
const parse = (value) => {
    const found = PATTERN.exec(String(value === null || value === undefined ? '' : value).trim());

    if (!found) return null;

    return {
        release: [Number(found[1]), Number(found[2] || 0), Number(found[3] || 0)],
        prerelease: found[4] ? found[4].split('.') : []
    };
};

/** A version string as it should be shown: no leading `v`, or null. */
const clean = (value) => (parse(value) ? String(value).trim().replace(/^v/i, '') : null);

// Semver's rule for the tail. Numeric identifiers compare as numbers and lose
// to alphanumeric ones, and a shorter run loses to a longer one that starts
// the same way. `rc.2` before `rc.10` rather than after it, which is the whole
// reason this is not a string comparison.
const comparePrerelease = (left, right) => {
    // Having one at all is what loses: 1.2.0-rc1 comes before 1.2.0.
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

        // One of each: the numeric one is always the earlier.
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;

        return a < b ? -1 : 1;
    }

    return 0;
};

/**
 * -1, 0 or 1 — or null when either side is not a version at all.
 *
 * The null is the point of the signature: "cannot say" and "the same" are
 * different answers, and collapsing them would let an unreadable version mean
 * "no update" without anybody deciding that it should.
 */
const compare = (left, right) => {
    const a = parse(left);
    const b = parse(right);

    if (!a || !b) return null;

    for (let at = 0; at < 3; at++) {
        if (a.release[at] !== b.release[at]) return a.release[at] < b.release[at] ? -1 : 1;
    }

    return comparePrerelease(a.prerelease, b.prerelease);
};

/** Whether `candidate` is worth offering to somebody already on `current`. */
const isNewer = (candidate, current) => compare(candidate, current) === 1;

module.exports = { parse, clean, compare, isNewer };
