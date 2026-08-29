// A port of the Homebrew Channel's `bubbles.c`, constant for constant. Everything spatial is in
// the channel's own units and scaled by the height of the surface, and the sprites are drawn.

const SPRITES = 3;

// config.h, verbatim.
const MIN_BUBBLE_COUNT = 4;
const MAX_BUBBLE_COUNT = 20;
const BUBBLE_TIME_CYCLE = 60 * 24;
const BUBBLE_MIN_TIME = 60 * 4;
const BUBBLE_MAX_OFFSET = 60 * 12;
const BUBBLE_SIZE_MIN = 0.4;
const BUBBLE_SIZE_MAX = 1.0;
const BUBBLE_POP_RADIUS = 0.8;
const BUBBLE_POP_MIN = 5;
const BUBBLE_POP_MAX = 10;
const BUBBLE_POP_SIZE_MIN = 0.2;
const BUBBLE_POP_SIZE_MAX = 0.4;
const BUBBLE_POP_SPREAD_X = 40;
const BUBBLE_POP_SPREAD_Y = 30;

const WII_HEIGHT = 480;
const SPRITE = 64;

// The channel ran at 60Hz and moved bubbles per frame, so a tab that misses frames must not run the ocean in
// slow motion.
const WII_HZ = 60;

const MAX_STEP_FRAMES = 3;

const random = (max) => Math.random() * max;
const randomInt = (max) => Math.floor(Math.random() * max);

// Sampled from `bubble1.png`: a soft annulus peaking at 63% of the radius and gone by 73%, with one highlight
// up and to the left.
const drawSprite = (size, opacity) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    const centre = size / 2;
    const radius = size / 2;

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

    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    const spot = ctx.createRadialGradient(
        centre - radius * 0.42, centre - radius * 0.42, 0,
        centre - radius * 0.42, centre - radius * 0.42, radius * 0.30
    );
    spot.addColorStop(0.0, 'rgba(230, 248, 255, 0.95)');
    spot.addColorStop(0.5, 'rgba(160, 213, 242, 0.45)');
    spot.addColorStop(1.0, 'rgba(160, 213, 242, 0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, size, size);

    const faded = document.createElement('canvas');
    faded.width = size;
    faded.height = size;
    const out = faded.getContext('2d');
    out.globalAlpha = opacity;
    out.drawImage(canvas, 0, 0);

    return faded;
};

const bubbles = (canvas) => {
    const ctx = canvas.getContext('2d');

    // Motion is the whole point of this element, so the preference means not drawing at all.
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let sprites = [];
    let width = 0;
    let height = 0;
    let unit = 1;          // screen pixels per channel pixel
    let scale = 1;         // backing-store pixels per CSS pixel

    let live = [];
    let popped = [];
    let target = MIN_BUBBLE_COUNT;

    // The channel tied the count to the clock: fewest at 04:00, most twelve hours later.
    const populationNow = () => {
        const minute = ((Date.now() / 60000 - BUBBLE_MIN_TIME) % BUBBLE_TIME_CYCLE + BUBBLE_TIME_CYCLE)
            % BUBBLE_TIME_CYCLE;

        const delta = MAX_BUBBLE_COUNT - MIN_BUBBLE_COUNT;

        const count = minute <= BUBBLE_MAX_OFFSET
            ? (delta * minute / BUBBLE_MAX_OFFSET) + MIN_BUBBLE_COUNT
            : (delta * (BUBBLE_TIME_CYCLE - minute) / (BUBBLE_TIME_CYCLE - BUBBLE_MAX_OFFSET)) + MIN_BUBBLE_COUNT;

        return Math.round(count * (width / (WII_HEIGHT * 4 / 3)));
    };

    const spawn = () => {
        const sprite = randomInt(SPRITES);
        const speed = 1.2 + random(4 - sprite);

        return {
            sprite,
            // The channel's `x` is the centre the sine wanders around, not the bubble's position.
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

    // bubble_pop(): the bubble is replaced by five to ten smaller ones, thrown outward and upward.
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

    const positionOf = (bubble) => ({
        x: (bubble.home + Math.round(bubble.sway * Math.sin(bubble.phase))) * unit,
        y: bubble.y * unit,
        radius: (bubble.size * SPRITE / 2) * unit
    });

    const advance = (bubble, frames) => {
        bubble.y -= bubble.speed * frames;
        bubble.phase += bubble.step * frames;
    };

    const resize = () => {
        // Backing store beyond 2 costs fill rate for a difference nobody can see on a blurred bubble.
        scale = Math.min(window.devicePixelRatio || 1, 2);

        width = canvas.clientWidth;
        height = canvas.clientHeight;

        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);

        unit = height / WII_HEIGHT;

        const size = Math.max(16, Math.round(SPRITE * BUBBLE_SIZE_MAX * unit * scale));
        sprites = [0.90, 0.38, 0.17].map((opacity) => drawSprite(size, opacity));

        target = populationNow();
    };

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

        // Re-read a few times a minute, or the count would add and drop a bubble continuously at the boundary.
        sinceCount += 1;
        if (sinceCount >= 600) {
            sinceCount = 0;
            target = populationNow();
        }

        if (live.length < target) live.push(spawn());
        // Shrinking lets one leave rather than deleting one, so bubbles never vanish in front of you.
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
        for (let i = 0; i < target; i++) {
            const bubble = spawn();
            bubble.y = random(height / unit);
            live.push(bubble);
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        live.forEach(paint);

        return { popAt: () => false, popAll: () => {}, stop: () => window.removeEventListener('resize', resize) };
    }

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
