// State, and being told when it changes.
//
// The same shape as the service's store, deliberately: one value, replaced
// rather than mutated, with everything else a pure function of it. Two
// implementations that behave alike are two fewer things to hold in mind.

/**
 * Creates a store.
 *
 * `update` takes a patch or a function of the current value and always
 * produces a new object, so a stale reference can never be mistaken for
 * current state. Subscribers run after every change.
 */
const createStore = (initial) => {
    let current = Object.freeze({ ...initial });
    const listeners = new Set();

    const get = () => current;

    const update = (patch) => {
        const changes = typeof patch === 'function' ? patch(current) : patch;
        const next = Object.freeze({ ...current, ...changes });

        // Nothing repaints if nothing moved — which keeps the log from
        // flickering while a poll returns the same answer over and over.
        if (Object.keys(changes).every((key) => current[key] === next[key])) return current;

        current = next;
        listeners.forEach((listener) => listener(current));
        return current;
    };

    const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };

    return { get, update, subscribe };
};

export { createStore };
