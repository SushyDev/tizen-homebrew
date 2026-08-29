'use strict';

// One cell whose value is only ever replaced. Functional core, imperative shell: this is the shell.
const createStore = (initial) => {
    let current = Object.freeze({ ...initial });

    const get = () => current;

    const update = (patch) => {
        const changes = typeof patch === 'function' ? patch(current) : patch;
        current = Object.freeze({ ...current, ...changes });
        return current;
    };

    const select = (key) => current[key];

    return { get, update, select };
};

module.exports = { createStore };
