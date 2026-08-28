// Rendering, in about fifty lines.
//
// The whole UI is a function of one state object, re-run whenever that state
// changes. That is the entire model — there are no components, no lifecycle
// and no virtual DOM, because a page with six panels does not need any.
//
// The one thing naive innerHTML gets wrong is focus: replacing the document on
// every keystroke would empty the field being typed into. So the page is split
// into named sections and only the sections whose markup actually changed are
// written back. Typing in one panel cannot disturb another.

/**
 * Escapes text for interpolation.
 *
 * Every value in a template goes through this unless explicitly marked safe,
 * so a package name or an error message from the TV cannot become markup.
 */
const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Marks a string as already-safe markup, so it is interpolated verbatim. */
const raw = (markup) => ({ __markup: String(markup) });

/**
 * Tagged template for markup.
 *
 * `html`<p>${name}</p>`` escapes name. Nested html`` results and anything
 * wrapped in raw() pass through untouched, and arrays are joined — which is
 * what makes lists read naturally.
 */
const html = (strings, ...values) => raw(strings.reduce((out, chunk, index) => {
    if (index === 0) return chunk;

    const value = values[index - 1];

    // `typeof` rather than truthiness: an empty html`` is legitimate markup
    // — it is how a view says "nothing here" — and testing it for truth
    // printed [object Object] on every screen that had nothing to report.
    const markup = (item) => (item && typeof item.__markup === 'string' ? item.__markup : escape(item));

    const rendered = Array.isArray(value) ? value.map(markup).join('') : markup(value);

    return out + rendered + chunk;
}, ''));

/**
 * Mounts a view.
 *
 * `sections` maps an element id to a function of state returning markup. On
 * every state change each is re-run, and only those whose output differs are
 * written — so an unchanged panel keeps its DOM, its focus and its scroll.
 */
const mount = (store, sections) => {
    const previous = new Map();

    const paint = (state) => {
        Object.entries(sections).forEach(([id, render]) => {
            const target = document.getElementById(id);
            if (!target) return;

            const markup = render(state).__markup;
            if (previous.get(id) === markup) return;

            previous.set(id, markup);
            target.innerHTML = markup;
        });
    };

    store.subscribe(paint);
    paint(store.get());

    return { paint };
};

/**
 * One delegated listener for the whole page.
 *
 * Because sections are replaced wholesale, per-element listeners would be lost
 * on every repaint. Instead handlers are named in markup with `data-on-click`
 * and looked up here, so markup stays declarative and nothing has to be
 * re-bound after a render.
 */
const delegate = (handlers) => {
    // An action is either an exact name — `upload` — or a prefixed one that
    // carries its argument, like `install:github:owner/repo`. The prefix form
    // is what lets a list row say what it does without needing a closure, so
    // markup stays declarative and nothing is re-bound after a repaint.
    const resolve = (action) => {
        if (handlers[action]) return [handlers[action], null];

        const separator = action.indexOf(':');
        if (separator === -1) return [null, null];

        const prefix = action.slice(0, separator);
        return handlers[prefix] ? [handlers[prefix], action.slice(separator + 1)] : [null, null];
    };

    const dispatch = (event, attribute) => {
        const target = event.target.closest(`[${attribute}]`);
        if (!target) return;

        const [handler, argument] = resolve(target.getAttribute(attribute));
        if (handler) handler(target, argument, event);
    };

    document.addEventListener('click', (event) => dispatch(event, 'data-on-click'));
    document.addEventListener('change', (event) => dispatch(event, 'data-on-change'));
    document.addEventListener('input', (event) => dispatch(event, 'data-on-input'));

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') dispatch(event, 'data-on-enter');
    });
};

export { html, raw, escape, mount, delegate };
