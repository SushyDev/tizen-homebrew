import { bubbles } from './bubbles.js';

// `pointer` is off on the television, where every pointer event is a synthetic one from the remote
// and would pop bubbles under a cursor nobody is aiming.
const sea = ({ pointer = true } = {}) => {
    const water = document.createElement('div');
    water.className = 'sea';
    water.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.className = 'bubbles';
    canvas.setAttribute('aria-hidden', 'true');

    document.body.insertBefore(canvas, document.body.firstChild);
    document.body.insertBefore(water, document.body.firstChild);

    const field = bubbles(canvas);

    if (pointer) {
        const at = (event) => field.popAt(event.clientX, event.clientY);

        document.addEventListener('pointermove', at, { passive: true });
        document.addEventListener('pointerdown', at, { passive: true });

        document.addEventListener('touchmove', (event) => {
            const touch = event.touches[0];
            if (touch) field.popAt(touch.clientX, touch.clientY);
        }, { passive: true });
    }

    return field;
};

export { sea };
