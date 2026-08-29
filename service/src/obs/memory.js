'use strict';

const { size } = require('./units.js');

// Every source is optional: on Tizen 9 Smack denies the service its own /proc.
const reading = (fn) => {
    try {
        const value = fn();
        return typeof value === 'number' && value >= 0 ? value : null;
    } catch (e) {
        return null;
    }
};

const sample = (proc) => {
    const source = proc || process;

    const heap = (() => {
        try {
            const stats = require('v8').getHeapStatistics();
            return { used: stats.used_heap_size, external: stats.external_memory };
        } catch (e) {
            return { used: null, external: null };
        }
    })();

    const lwnode = source.lwnode;

    return {
        rss: reading(() => source.memoryUsage().rss),

        peakRss: (() => {
            const kb = reading(() => source.resourceUsage().maxRSS);
            return kb === null ? null : kb * 1024;
        })(),

        heap: heap.used !== undefined ? heap.used : null,
        external: heap.external !== undefined ? heap.external : null,
        pss: lwnode && typeof lwnode.PssUsage === 'function' ? reading(() => lwnode.PssUsage()) : null
    };
};

const level = (of) => {
    if (!of) return null;
    if (of.pss !== null && of.pss !== undefined) return of.pss;
    if (of.rss !== null && of.rss !== undefined) return of.rss;
    if (of.heap !== null && of.heap !== undefined) {
        return of.heap + (of.external || 0);
    }
    return null;
};

const peak = (proc) => {
    let highest = null;
    let at = null;

    return {
        at(step) {
            const now = sample(proc);

            if (level(now) !== null && (highest === null || level(now) > level(highest))) {
                highest = now;
                at = step;
            }

            return now;
        },
        highest: () => (highest ? { ...highest, at } : { at: null })
    };
};

const describe = (of) => {
    if (!of) return 'unmeasurable';

    const parts = [];

    if (of.pss !== null && of.pss !== undefined) parts.push(`${size(of.pss)} pss`);
    if (of.rss !== null && of.rss !== undefined) parts.push(`${size(of.rss)} rss`);
    if (of.heap !== null && of.heap !== undefined) parts.push(`${size(of.heap)} heap`);
    if (of.external !== null && of.external !== undefined) parts.push(`${size(of.external)} external`);

    return parts.length ? parts.join(' + ') : 'unmeasurable';
};

module.exports = { sample, peak, describe, level };
