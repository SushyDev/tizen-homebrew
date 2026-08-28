// The bubbles.
//
// A port of the Homebrew Channel's `bubbles.c`, constant for constant. The
// numbers are not approximations of how it felt — they are the numbers, read
// out of `config.h`, so a bubble here rises at the speed a bubble there rose
// and wanders sideways by the same amount.
//
// Three things had to change, and each is marked where it happens:
//
//   · The channel drew 64px sprites onto a 640×480 framebuffer. This draws
//     onto whatever surface it is given — 1920 wide on the television, 390 on
//     a phone — so everything spatial is expressed in the channel's units and
//     scaled by the height of the surface. That keeps the *composition*
//     identical at any resolution rather than the pixel counts.
//   · The sprites are drawn rather than loaded. A 64px bitmap upscaled to a
//     television is a blurry disc; the same bubble as a handful of gradient
//     stops is sharp at any size and costs three canvases at startup.
//   · The channel popped bubbles under the Wii pointer. A phone has a finger
//     and a television has neither, so `popAll` exists for the remote's OK
//     button and `popAt` for anything with coordinates.

const SPRITES = 3;

// config.h, verbatim.
const MIN_BUBBLE_COUNT = 4;
const MAX_BUBBLE_COUNT = 20;
const BUBBLE_TIME_CYCLE = 60 * 24;     // minutes in the cycle
const BUBBLE_MIN_TIME = 60 * 4;        // fewest bubbles at 04:00
const BUBBLE_MAX_OFFSET = 60 * 12;     // most bubbles twelve hours later
const BUBBLE_SIZE_MIN = 0.4;
const BUBBLE_SIZE_MAX = 1.0;
const BUBBLE_POP_RADIUS = 0.8;
const BUBBLE_POP_MIN = 5;
const BUBBLE_POP_MAX = 10;
const BUBBLE_POP_SIZE_MIN = 0.2;
const BUBBLE_POP_SIZE_MAX = 0.4;
const BUBBLE_POP_SPREAD_X = 40;
const BUBBLE_POP_SPREAD_Y = 30;

// The framebuffer those constants were tuned against, and the sprite size
// they were tuned against. Everything spatial below is in these units and
// multiplied by `unit` on the way to the screen.
const WII_HEIGHT = 480;
const SPRITE = 64;

// The channel ran at 60Hz and moved bubbles by a fixed amount per frame, so
// its speeds are per-frame rather than per-second. A browser tab that misses
// frames would otherwise run the whole ocean in slow motion.
const WII_HZ = 60;

// A dropped tab, a backgrounded app or a slow first paint can hand back a
// delta of several seconds. Advancing the simulation by that much teleports
// every bubble; clamping it simply loses that time, which nobody can see.
const MAX_STEP_FRAMES = 3;

const random = (max) => Math.random() * max;
const randomInt = (max) => Math.floor(Math.random() * max);

/**
 * Draws one bubble sprite onto its own canvas.
 *
 * Sampled from `bubble1.png`: the bubble is a soft annulus, transparent in
 * the middle, rising to peak opacity at about 63% of the radius and gone by
 * 73%. The film is a mid ocean blue with a brighter outer rim, and there is
 * one bright specular highlight up and to the left where the surface light
 * catches it.
 *
 * The faint hue shift around the rim is the one thing the channel's own
 * bubbles do not have. It is thin-film iridescence — the Frutiger Aero half
 * of this interface's parentage — and it is kept low enough that it reads as
 * a bubble catching the light rather than as a colour effect.
 */
const drawSprite = (size, opacity) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    const centre = size / 2;
    const radius = size / 2;

    // The film.
    const film = ctx.createRadialGradient(centre, centre, 0, centre, centre, radius);
    film.addColorStop(0.00, 'rgba(15, 71, 102, 0)');
    film.addColorStop(0.37, 'rgba(15, 71, 102, 0.02)');
    film.addColorStop(0.50, 'rgba(15, 70, 100, 0.14)');
    film.addColorStop(0.57, 'rgba(15, 71, 102, 0.44)');
    film.addColorStop(0.63, 'rgba(20, 105, 151, 0.90)');
    film.addColorStop(0.69, 'rgba(38, 140, 190, 0.82)');
    film.addColorStop(0.73, 'rgba(20, 105, 151, 0)');
    ctx.fillStyle = film;
    ctx.fillRect(0, 0, size, size);

    // Iridescence, on the rim only, and only just visible.
    const rim = ctx.createLinearGradient(0, 0, size, size);
    rim.addColorStop(0.00, 'rgba(140, 255, 240, 0.30)');
    rim.addColorStop(0.35, 'rgba(255, 255, 255, 0.10)');
    rim.addColorStop(0.65, 'rgba(180, 200, 255, 0.14)');
    rim.addColorStop(1.00, 'rgba(255, 170, 230, 0.26)');

    const band = ctx.createRadialGradient(centre, centre, 0, centre, centre, radius);
    band.addColorStop(0.00, 'rgba(0, 0, 0, 0)');
    band.addColorStop(0.58, 'rgba(0, 0, 0, 0)');
    band.addColorStop(0.65, 'rgba(0, 0, 0, 1)');
    band.addColorStop(0.72, 'rgba(0, 0, 0, 0)');

    // Painted through the annulus so the hue only ever lands on the rim.
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    // The specular highlight: up and to the left, as in every one of the
    // channel's three sprites.
    const spot = ctx.createRadialGradient(
        centre - radius * 0.42, centre - radius * 0.42, 0,
        centre - radius * 0.42, centre - radius * 0.42, radius * 0.30
    );
    spot.addColorStop(0.0, 'rgba(230, 248, 255, 0.95)');
    spot.addColorStop(0.5, 'rgba(160, 213, 242, 0.45)');
    spot.addColorStop(1.0, 'rgba(160, 213, 242, 0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, size, size);

    // The three sprites are the same bubble at three opacities — which is
    // also why the channel gives the faint ones the slower speeds. Near and
    // bold, or far and dim: it is the only depth cue the scene has.
    const faded = document.createElement('canvas');
    faded.width = size;
    faded.height = size;
    const out = faded.getContext('2d');
    out.globalAlpha = opacity;
    out.drawImage(canvas, 0, 0);

    return faded;
};

/**
 * Starts the bubble field on a canvas.
 *
 * Returns the handles the pages need: `popAll` for the remote's OK button,
 * `popAt` for a finger or a mouse, and `stop` for teardown.
 */
const bubbles = (canvas) => {
    const ctx = canvas.getContext('2d');

    // Motion is the whole point of this element, so honouring the preference
    // means not drawing at all rather than drawing slowly.
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let sprites = [];
    let width = 0;
    let height = 0;
    let unit = 1;          // screen pixels per channel pixel
    let scale = 1;         // backing-store pixels per CSS pixel

    let live = [];         // the rising bubbles
    let popped = [];       // and the fragments of the ones that burst
    let target = MIN_BUBBLE_COUNT;

    // --- the population ---------------------------------------------------

    /**
     * How many bubbles the time of day calls for.
     *
     * The channel tied the count to the clock: fewest at 04:00, most twelve
     * hours later, ramping linearly between. It is a detail nobody would ever
     * notice and it is exactly why the screen felt alive, so it is kept.
     */
    const populationNow = () => {
        const minute = ((Date.now() / 60000 - BUBBLE_MIN_TIME) % BUBBLE_TIME_CYCLE + BUBBLE_TIME_CYCLE)
            % BUBBLE_TIME_CYCLE;

        const delta = MAX_BUBBLE_COUNT - MIN_BUBBLE_COUNT;

        const count = minute <= BUBBLE_MAX_OFFSET
            ? (delta * minute / BUBBLE_MAX_OFFSET) + MIN_BUBBLE_COUNT
            : (delta * (BUBBLE_TIME_CYCLE - minute) / (BUBBLE_TIME_CYCLE - BUBBLE_MAX_OFFSET)) + MIN_BUBBLE_COUNT;

        // The channel's counts are for a 640-wide screen. A television is
        // three times that and a phone is half, and a fixed count would read
        // as a crowd on one and as a drizzle on the other. Area is the wrong
        // measure — bubbles rise in columns, so it is width that decides how
        // many fit.
        return Math.round(count * (width / (WII_HEIGHT * 4 / 3)));
    };

    // bubble_rand()
    const spawn = () => {
        const sprite = randomInt(SPRITES);
        const speed = 1.2 + random(4 - sprite);

        return {
            sprite,
            // The channel's `x` is the centre the sine wanders around, not
            // the bubble's position — `coords.x` is recomputed from it every
            // frame. Same here.
            home: random(width / unit),
            y: (height / unit) + random(200),
            speed,
            sway: 3.0 + (randomInt(sprite + 1) * speed),
            phase: 0,
            step: (Math.PI * 2) / (64 + random(64)),
            size: BUBBLE_SIZE_MIN + random(BUBBLE_SIZE_MAX - BUBBLE_SIZE_MIN),
            spin: random(Math.PI / 4)
        };
    };

    // bubble_pop(): the bubble is replaced by five to ten smaller ones,
    // thrown outward and upward from where it burst.
    const burst = (bubble) => {
        const count = randomInt(BUBBLE_POP_MAX - BUBBLE_POP_MIN) + BUBBLE_POP_MIN;

        for (let i = 0; i < count; i++) {
            const angle = random(Math.PI * 2);

            popped.push({
                sprite: bubble.sprite,
                home: bubble.home + (Math.sin(angle) * random(BUBBLE_POP_SPREAD_X)),
                y: bubble.y + ((Math.cos(angle) - 1.5) * random(BUBBLE_POP_SPREAD_Y)),
                speed: bubble.speed - 0.5 + random(4 - bubble.sprite),
                sway: bubble.sway * (0.8 + random(1.0)),
                phase: bubble.phase,
                step: bubble.step * (0.8 + random(0.4)),
                size: (BUBBLE_POP_SIZE_MIN + random(BUBBLE_POP_SIZE_MAX - BUBBLE_POP_SIZE_MIN)) * bubble.size,
                spin: bubble.spin
            });
        }
    };

    // --- geometry ---------------------------------------------------------

    /** Where a bubble is this frame, in CSS pixels. */
    const positionOf = (bubble) => ({
        x: (bubble.home + Math.round(bubble.sway * Math.sin(bubble.phase))) * unit,
        y: bubble.y * unit,
        radius: (bubble.size * SPRITE / 2) * unit
    });

    const advance = (bubble, frames) => {
        bubble.y -= bubble.speed * frames;
        bubble.phase += bubble.step * frames;
    };

    // --- the surface ------------------------------------------------------

    const resize = () => {
        // A television reports a device pixel ratio of 1 and a phone reports
        // two or three. Backing store beyond 2 costs fill rate for a
        // difference nobody can see on a blurred bubble.
        scale = Math.min(window.devicePixelRatio || 1, 2);

        width = canvas.clientWidth;
        height = canvas.clientHeight;

        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);

        unit = height / WII_HEIGHT;

        // Sprites are rasterised once, at the size the largest bubble will
        // actually be drawn, so nothing is ever scaled up at draw time.
        const size = Math.max(16, Math.round(SPRITE * BUBBLE_SIZE_MAX * unit * scale));
        sprites = [0.90, 0.38, 0.17].map((opacity) => drawSprite(size, opacity));

        target = populationNow();
    };

    // --- the frame --------------------------------------------------------

    let previous = 0;
    let handle = 0;
    let sinceCount = 0;

    const paint = (bubble) => {
        const { x, y, radius } = positionOf(bubble);
        const sprite = sprites[bubble.sprite];
        const drawn = radius * 2 * scale;

        ctx.save();
        ctx.translate(x * scale, y * scale);
        ctx.rotate(bubble.spin);
        ctx.drawImage(sprite, -drawn / 2, -drawn / 2, drawn, drawn);
        ctx.restore();
    };

    const frame = (now) => {
        handle = window.requestAnimationFrame(frame);

        const frames = Math.min(((now - previous) / 1000) * WII_HZ, MAX_STEP_FRAMES);
        previous = now;

        // The channel re-read the clock every six hundred frames rather than
        // every frame, because reading the Wii's RTC was expensive. Nothing
        // here is expensive, but the population should still only drift a few
        // times a minute — a count that recomputed every frame would add and
        // drop a bubble continuously at the boundary.
        sinceCount += 1;
        if (sinceCount >= 600) {
            sinceCount = 0;
            target = populationNow();
        }

        if (live.length < target) live.push(spawn());
        // Shrinking is done by letting one leave rather than deleting one,
        // so bubbles never vanish in front of you.
        if (live.length > target && live.length > 0) live[0].y = -1000;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const ceiling = -100;

        for (let i = 0; i < live.length; i++) {
            advance(live[i], frames);
            if (live[i].y < ceiling) live[i] = spawn();
            paint(live[i]);
        }

        for (let i = popped.length - 1; i >= 0; i--) {
            advance(popped[i], frames);
            if (popped[i].y < ceiling) {
                popped.splice(i, 1);
                continue;
            }
            paint(popped[i]);
        }
    };

    // --- what pops them ---------------------------------------------------

    /** Pops whatever is under a point, in CSS pixels. */
    const popAt = (px, py) => {
        for (let i = live.length - 1; i >= 0; i--) {
            const { x, y, radius } = positionOf(live[i]);
            const reach = radius * BUBBLE_POP_RADIUS;

            if (Math.abs(px - x) < reach && Math.abs(py - y) < reach) {
                burst(live[i]);
                live[i] = spawn();
                return true;
            }
        }

        return false;
    };

    /** bubble_popall(): the whole field at once. */
    const popAll = () => {
        const all = live;
        live = [];
        all.forEach(burst);
    };

    const stop = () => {
        window.cancelAnimationFrame(handle);
        window.removeEventListener('resize', resize);
    };

    resize();
    window.addEventListener('resize', resize);

    if (still) {
        // One still frame, so the water is not empty.
        for (let i = 0; i < target; i++) {
            const bubble = spawn();
            bubble.y = random(height / unit);
            live.push(bubble);
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        live.forEach(paint);

        return { popAt: () => false, popAll: () => {}, stop: () => window.removeEventListener('resize', resize) };
    }

    // Starting mid-screen rather than below it, so the first frame is a scene
    // instead of an empty ocean that slowly fills.
    for (let i = 0; i < target; i++) {
        const bubble = spawn();
        bubble.y = random(height / unit);
        live.push(bubble);
    }

    previous = window.performance ? window.performance.now() : Date.now();
    handle = window.requestAnimationFrame(frame);

    return { popAt, popAll, stop };
};

export { bubbles };
