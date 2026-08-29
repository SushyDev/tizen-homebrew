'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');

const DIGITS = 6;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// Not a secret: a build pushed at a television every few minutes should not have to be read off its screen.
const DEVELOPER_PIN = '0'.repeat(DIGITS);

const generate = () => {
    const ceiling = 10 ** DIGITS;

    const draw = () => {
        // Rejection sampling: a modulus of a random 32-bit value would make the low PINs likelier.
        const limit = Math.floor(0xffffffff / ceiling) * ceiling;
        for (;;) {
            const value = randomBytes(4).readUInt32BE(0);
            if (value < limit) return value % ceiling;
        }
    };

    return String(draw()).padStart(DIGITS, '0');
};

const matches = (attempt, pin) => {
    const given = Buffer.from(String(attempt ?? ''));
    const expected = Buffer.from(pin);

    // timingSafeEqual needs equal lengths, so length is compared first.
    if (given.length !== expected.length) return false;

    return timingSafeEqual(given, expected);
};

const fresh = () => ({ failures: 0, lockedUntil: 0 });

const remaining = (lockout, now = Date.now()) => Math.max(0, lockout.lockedUntil - now);

const isLocked = (lockout, now = Date.now()) => remaining(lockout, now) > 0;

const recordFailure = (lockout, now = Date.now()) => {
    const failures = lockout.failures + 1;

    // Reaching the limit starts the timer and resets the count, so each lockout has to be earned again.
    return failures >= MAX_ATTEMPTS
        ? { failures: 0, lockedUntil: now + LOCKOUT_MS }
        : { failures, lockedUntil: lockout.lockedUntil };
};

const recordSuccess = () => fresh();

module.exports = {
    generate, matches, fresh, remaining, isLocked, recordFailure, recordSuccess,
    DIGITS, MAX_ATTEMPTS, LOCKOUT_MS, DEVELOPER_PIN
};
