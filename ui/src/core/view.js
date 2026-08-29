// Every value in a template goes through this unless marked raw(), so a package name or a message
// from the TV cannot become markup.
const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const raw = (markup) => ({ __markup: String(markup) });

const html = (strings, ...values) => raw(strings.reduce((out, chunk, index) => {
    if (index === 0) return chunk;

    const value = values[index - 1];

    // `typeof` rather than truthiness: an empty html`` is legitimate markup, and testing it for
    // truth printed [object Object] on every screen that had nothing to report.
    const markup = (item) => (item && typeof item.__markup === 'string' ? item.__markup : escape(item));

    const rendered = Array.isArray(value) ? value.map(markup).join('') : markup(value);

    return out + rendered + chunk;
}, ''));

// Replacing the document on every keystroke would empty the field being typed into, so the page is
// split into named sections and only those whose markup changed are written back.
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

const delegate = (handlers) => {
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

    document.addEventListener('error', (event) => {
        const image = event.target;
        if (image && image.tagName === 'IMG' && image.parentNode) image.parentNode.removeChild(image);
    }, true);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') dispatch(event, 'data-on-enter');
    });
};

export { html, raw, escape, mount, delegate };
