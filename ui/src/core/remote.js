// The television remote.
//
// A TV has no pointer. Everything a person can reach, they reach by pressing
// a direction and watching something else light up — so the interface owes
// them two things: a focus that is unmissable from three metres, and a
// direction key that always moves to the thing a person would say is in that
// direction.
//
// The second is the harder one. Tab order is document order, which on a
// two-column screen sends you diagonally across the room. So movement here is
// geometric: from the focused element's edge, find every candidate that lies
// in the pressed direction and take the nearest, measuring distance along the
// axis you pressed and penalising drift across it. That is the rule every TV
// platform's own focus engine uses, and it is short enough to just write.
//
// The other thing this file exists for is that `core/view.js` replaces whole
// sections of the document on every repaint. Any focus held on a DOM node is
// destroyed by that. So focus is held as a *name* — `data-focus="theme"` —
// and re-resolved after each paint, which is why a screen can update
// underneath you without the remote losing its place.

// Samsung's TV keys. Arrows and Enter are ordinary web key codes; Return is
// Samsung's own, and is the one every TV app must handle because it is how a
// person leaves.
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

/** Everything focusable, in document order, that is currently on screen. */
const candidates = (root) => Array.prototype.slice
    .call(root.querySelectorAll('[data-focus]'))
    .filter((element) => !element.disabled && element.offsetParent !== null);

/**
 * Scores how well `to` answers a press of `direction` from `from`.
 *
 * Returns null when `to` is not in that direction at all. Otherwise the
 * score is the distance travelled along the axis pressed, plus twice the
 * drift across it — so a target slightly further away but directly in line
 * beats a nearer one off to the side, which is what a person means when they
 * press right.
 */
const score = (from, to, direction) => {
    const horizontal = direction === 'left' || direction === 'right';

    // Along the axis pressed: how far the near edge of the target is beyond
    // the far edge of where we are.
    const along = {
        left:  from.left - to.right,
        right: to.left - from.right,
        up:    from.top - to.bottom,
        down:  to.top - from.bottom
    }[direction];

    // A target has to actually be over there. The tolerance covers rows whose
    // boxes overlap by a pixel or two through rounding.
    if (along < -1) return null;

    const fromCentre = horizontal
        ? from.top + from.height / 2
        : from.left + from.width / 2;
    const toCentre = horizontal
        ? to.top + to.height / 2
        : to.left + to.width / 2;

    return Math.max(along, 0) + Math.abs(toCentre - fromCentre) * 2;
};

/**
 * Wires a page for the remote.
 *
 * `onBack` is called for the Return key, and is not optional in practice: a
 * TV app that does not handle it traps the person inside it.
 */
const remote = ({ root = document, onBack = () => {}, onKey = () => false } = {}) => {
    let name = null;

    const elementFor = (wanted) => (wanted
        ? candidates(root).filter((element) => element.getAttribute('data-focus') === wanted)[0] || null
        : null);

    const current = () => elementFor(name);

    /** Lights one element and puts the browser's own focus on it too. */
    const light = (element) => {
        candidates(root).forEach((other) => other.classList.remove('is-focus'));

        if (!element) {
            name = null;
            return;
        }

        name = element.getAttribute('data-focus');
        element.classList.add('is-focus');

        // The class does the visible work; this makes the platform agree, so
        // Enter lands on the right element and a screen reader follows.
        if (element.focus) element.focus({ preventScroll: true });
    };

    /** Focuses by name, falling back to the first thing on screen. */
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

        // Nothing over there is not a failure; it is the edge of the screen,
        // and the focus stays where it is rather than wrapping somewhere
        // surprising.
        if (best) light(best.element);
    };

    const onKeydown = (event) => {
        // The page's own handler gets first refusal, so a screen can claim a
        // colour key or Play without this file knowing what they mean.
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

    /**
     * Adopts focus the platform moved on its own.
     *
     * `.is-focus` and the browser's own focus are two cursors for one idea,
     * and app.css lights a control for either — so the moment they disagree,
     * two things on screen claim to be the current one. They disagree as soon
     * as anything focuses a control without going through `light()`: a mouse
     * click, a tap, a Tab press, or the platform restoring focus after a
     * repaint.
     *
     * Rather than forbid those, this follows them. Whatever ends up focused
     * becomes the cursor, so every way of choosing something converges on the
     * same one and there is only ever one lit control.
     */
    const onFocusIn = (event) => {
        const control = event.target.closest && event.target.closest('[data-focus]');
        if (!control || control === current()) return;
        light(control);
    };

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('focusin', onFocusIn);

    return {
        KEY,

        /** Puts focus somewhere sensible, by name where there is a preference. */
        focus,

        /** The name of whatever is focused, or null. */
        get focused() { return name; },

        /**
         * Re-lights after a repaint.
         *
         * `core/view.js` rewrites whole sections, so the element that had
         * focus a moment ago is gone and an identical one has taken its
         * place. Called from the paint, this puts the light back on it.
         */
        restore() {
            const here = current();
            if (here) {
                light(here);
            } else if (name) {
                // What was focused is no longer on screen — a tab changed, or
                // a panel closed. Land on the first thing rather than nothing.
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
