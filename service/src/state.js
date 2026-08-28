'use strict';

// The one place anything is allowed to change.
//
// Everything else in this service is const and returns new values. A server
// cannot be entirely immutable — it holds sockets, and it has to remember
// whether an install is already running — so rather than scatter that, all of
// it lives in a single cell here whose value is only ever *replaced*.
//
// Functional core, imperative shell: this file is the shell.

/**
 * Creates a store around an initial value.
 *
 * `update` takes either a patch object or a function of the current value,
 * and always produces a new object. Nothing hands out a mutable reference, so
 * a caller cannot change state by accident — only by asking.
 */
const createStore = (initial) => {
    let current = Object.freeze({ ...initial });

    const get = () => current;

    const update = (patch) => {
        const changes = typeof patch === 'function' ? patch(current) : patch;
        current = Object.freeze({ ...current, ...changes });
        return current;
    };

    // Reading one field is common enough to be worth naming.
    const select = (key) => current[key];

    return { get, update, select };
};

module.exports = { createStore };
