// The ground both pages stand on.
//
// Two fixed layers behind the document: the water, which is entirely CSS and
// therefore free, and the bubbles, which are a canvas. Neither is in the
// markup either page writes, because neither belongs to any screen — the sea
// is the room, not a component of what is in it.
//
// Popping is wired here rather than in `bubbles.js` so the simulation stays a
// simulation and knows nothing about input. A finger drags through the water
// and pops what it touches; the remote's OK button, which has no coordinates
// to give, bursts the lot at once.

import { bubbles } from './bubbles.js';

/**
 * Puts the sea behind the page.
 *
 * `pointer` is off on the television, where every pointer event that exists
 * is a synthetic one from the remote and would pop bubbles under a focus
 * cursor nobody is aiming with.
 */
const sea = ({ pointer = true } = {}) => {
    const water = document.createElement('div');
    water.className = 'sea';
    water.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.className = 'bubbles';
    canvas.setAttribute('aria-hidden', 'true');

    // First child, so nothing in the document has to fight it for stacking
    // order beyond the negative z-index it already has.
    document.body.insertBefore(canvas, document.body.firstChild);
    document.body.insertBefore(water, document.body.firstChild);

    const field = bubbles(canvas);

    if (pointer) {
        // The canvas cannot receive these itself: it is `pointer-events:
        // none`, which is what stops it swallowing every tap meant for the
        // interface in front of it. So the document is listened to instead
        // and the coordinates are already in the right space.
        const at = (event) => field.popAt(event.clientX, event.clientY);

        document.addEventListener('pointermove', at, { passive: true });
        document.addEventListener('pointerdown', at, { passive: true });

        // Chromium 63 predates pointer events on some builds; touch is the
        // fallback and is harmless where both fire.
        document.addEventListener('touchmove', (event) => {
            const touch = event.touches[0];
            if (touch) field.popAt(touch.clientX, touch.clientY);
        }, { passive: true });
    }

    return field;
};

export { sea };
