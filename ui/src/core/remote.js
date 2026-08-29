// Movement is geometric rather than by document order: from the focused element's edge, take the
// nearest candidate in the pressed direction. Focus is held as a name, because core/view.js
// replaces whole sections of the document on every repaint.

// Return is Samsung's own key, and how a person leaves a TV app.
const KEY = {
    left: 37,
    up: 38,
    right: 39,
    down: 40,
    enter: 13,
    back: 10009,
    escape: 27
};

const DIRECTIONS = {
    [KEY.left]:  'left',
    [KEY.up]:    'up',
    [KEY.right]: 'right',
    [KEY.down]:  'down'
};

const candidates = (root) => Array.prototype.slice
    .call(root.querySelectorAll('[data-focus]'))
    .filter((element) => !element.disabled && element.offsetParent !== null);

// Null when `to` is not in that direction. Otherwise distance along the axis pressed plus twice
// the drift across it, so a target in line beats a nearer one off to the side.
const score = (from, to, direction) => {
    const horizontal = direction === 'left' || direction === 'right';

    const along = {
        left:  from.left - to.right,
        right: to.left - from.right,
        up:    from.top - to.bottom,
        down:  to.top - from.bottom
    }[direction];

    if (along < -1) return null;

    const fromCentre = horizontal
        ? from.top + from.height / 2
        : from.left + from.width / 2;
    const toCentre = horizontal
        ? to.top + to.height / 2
        : to.left + to.width / 2;

    return Math.max(along, 0) + Math.abs(toCentre - fromCentre) * 2;
};

// `onBack` is not optional in practice: a TV app that does not handle Return traps the person inside it.
const remote = ({ root = document, onBack = () => {}, onKey = () => false } = {}) => {
    let name = null;

    const elementFor = (wanted) => (wanted
        ? candidates(root).filter((element) => element.getAttribute('data-focus') === wanted)[0] || null
        : null);

    const current = () => elementFor(name);

    const light = (element) => {
        candidates(root).forEach((other) => other.classList.remove('is-focus'));

        if (!element) {
            name = null;
            return;
        }

        name = element.getAttribute('data-focus');
        element.classList.add('is-focus');

        if (element.focus) element.focus({ preventScroll: true });
    };

    const focus = (wanted) => light(elementFor(wanted) || candidates(root)[0] || null);

    const move = (direction) => {
        const here = current();
        const all = candidates(root);

        if (!here) return light(all[0] || null);

        const from = here.getBoundingClientRect();

        const best = all
            .filter((element) => element !== here)
            .map((element) => ({ element, cost: score(from, element.getBoundingClientRect(), direction) }))
            .filter((entry) => entry.cost !== null)
            .sort((a, b) => a.cost - b.cost)[0];

        // Nothing over there is the edge of the screen, not a failure, so focus stays where it is.
        if (best) light(best.element);
    };

    const onKeydown = (event) => {
        if (onKey(event.keyCode, event)) {
            event.preventDefault();
            return;
        }

        if (event.keyCode === KEY.back || event.keyCode === KEY.escape) {
            event.preventDefault();
            onBack();
            return;
        }

        const direction = DIRECTIONS[event.keyCode];

        if (direction) {
            event.preventDefault();
            move(direction);
            return;
        }

        if (event.keyCode === KEY.enter) {
            const here = current();
            if (here) {
                event.preventDefault();
                here.click();
            }
        }
    };

    // `.is-focus` and the browser's own focus are two cursors for one idea, and app.css lights a
    // control for either — so rather than forbid a click or a Tab, whatever ends up focused becomes
    // the cursor and there is only ever one lit control.
    const onFocusIn = (event) => {
        const control = event.target.closest && event.target.closest('[data-focus]');
        if (!control || control === current()) return;
        light(control);
    };

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('focusin', onFocusIn);

    return {
        KEY,

        focus,

        get focused() { return name; },

        // core/view.js rewrites whole sections, so this puts the light back on the element that replaced the
        // focused one.
        restore() {
            const here = current();
            if (here) {
                light(here);
            } else if (name) {
                focus(null);
            }
        },

        stop() {
            document.removeEventListener('keydown', onKeydown);
            document.removeEventListener('focusin', onFocusIn);
        }
    };
};

export { remote, KEY };
