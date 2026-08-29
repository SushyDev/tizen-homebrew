'use strict';

// The pairing PIN, and what happens when someone keeps guessing it.
//
// Tizen Homebrew binds to every interface so a phone can reach it, which means the
// PIN is the only thing between the LAN and an install — and, when the relay
// is on, a shell. Six digits is a million guesses: fine against a person at a
// keyboard, minutes for a script. So failures have to stop being cheap.
//
// The functions here are pure. Lockout state is a value passed in and returned
// changed, so the rules can be tested without a clock or a server.

const { randomBytes, timingSafeEqual } = require('crypto');

const DIGITS = 6;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// What a developer build pairs with instead of a fresh PIN. Not a secret and
// not meant to be one: it exists so a build pushed at a television every few
// minutes does not have to be read off its screen each time. main.js says so
// out loud in the log, and a release build refuses to carry it.
const DEVELOPER_PIN = '0'.repeat(DIGITS);

/**
 * A fresh PIN, from the system CSPRNG.
 *
 * Regenerated every time the service starts and never persisted, so a PIN
 * cannot outlive the session it authorised.
 */
const generate = () => {
    const ceiling = 10 ** DIGITS;

    // Rejection sampling: taking a modulus of a random 32-bit value would
    // make the low PINs fractionally likelier. It costs nothing to be exact.
    const draw = () => {
        const limit = Math.floor(0xffffffff / ceiling) * ceiling;
        for (;;) {
            const value = randomBytes(4).readUInt32BE(0);
            if (value < limit) return value % ceiling;
        }
    };

    return String(draw()).padStart(DIGITS, '0');
};

/**
 * Compares an attempt against the PIN without leaking the answer through
 * timing. Node's own timingSafeEqual needs equal lengths, so the attempt is
 * measured against a same-length buffer first.
 */
const matches = (attempt, pin) => {
    const given = Buffer.from(String(attempt ?? ''));
    const expected = Buffer.from(pin);

    if (given.length !== expected.length) return false;

    return timingSafeEqual(given, expected);
};

/** The empty lockout: no failures, not locked. */
const fresh = () => ({ failures: 0, lockedUntil: 0 });

/** Milliseconds left on a lockout, or 0 when there is none. */
const remaining = (lockout, now = Date.now()) => Math.max(0, lockout.lockedUntil - now);

/** True when attempts should be refused outright. */
const isLocked = (lockout, now = Date.now()) => remaining(lockout, now) > 0;

/**
 * Records a wrong guess, returning the new lockout state.
 * Reaching the limit starts the timer and resets the count, so each lockout
 * has to be earned again rather than every further attempt extending it.
 */
const recordFailure = (lockout, now = Date.now()) => {
    const failures = lockout.failures + 1;

    return failures >= MAX_ATTEMPTS
        ? { failures: 0, lockedUntil: now + LOCKOUT_MS }
        : { failures, lockedUntil: lockout.lockedUntil };
};

/** Records a correct guess: the slate is clean. */
const recordSuccess = () => fresh();

module.exports = {
    generate, matches, fresh, remaining, isLocked, recordFailure, recordSuccess,
    DIGITS, MAX_ATTEMPTS, LOCKOUT_MS, DEVELOPER_PIN
};
