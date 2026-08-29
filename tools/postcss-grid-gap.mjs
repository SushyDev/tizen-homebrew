// `gap` is `grid-gap` until Chromium 66, and getting it wrong is invisible: the stylesheet parses,
// every rule applies, and nothing on the television has any spacing.
//
// postcss-gap-properties does the right thing for `display: grid` and silently nothing for
// `inline-grid`, which is every button in this interface. So the whole rule lives here: a rule that
// lays its children out on a grid and sets a gap also gets the name Chromium 57 understands.

const LEGACY = {
    gap: 'grid-gap',
    'row-gap': 'grid-row-gap',
    'column-gap': 'grid-column-gap'
};

const GRID = /^\s*(?:inline-)?grid\s*$/;

const gridGap = () => ({
    postcssPlugin: 'grid-gap',

    Rule(rule) {
        let onAGrid = false;
        const gaps = [];

        rule.each((node) => {
            if (node.type !== 'decl') return;

            if (node.prop === 'display' && GRID.test(node.value)) onAGrid = true;
            if (LEGACY[node.prop]) gaps.push(node);
        });

        if (!onAGrid) return;

        gaps.forEach((declaration) => {
            const legacy = LEGACY[declaration.prop];

            const already = declaration.parent.some(
                (node) => node.type === 'decl' && node.prop === legacy
            );

            if (already) return;

            declaration.cloneBefore({ prop: legacy });
        });
    }
});

gridGap.postcss = true;

export { gridGap };
