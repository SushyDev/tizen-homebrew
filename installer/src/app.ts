// The guided install, one screen at a time.
//
// The machine running this is assumed to have nothing on it — no Node, no Tizen Studio, no git — so
// this is compiled to a single binary carrying its own runtime. What it runs is this repository's
// own code, including the files the television runs itself, rather than a second implementation of
// any of it.

import { BoxRenderable, TextRenderable, SelectRenderable, SelectRenderableEvents, t, bold, fg, dim } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";

import * as work from "./work.js";

export type Options = {
    wgt?: string | null;
    level?: "Partner" | "Public";
    onFinish?: (code: number) => void;
};

const ACCENT = "#7dd3fc";
const GOOD = "#86efac";
const BAD = "#fca5a5";
const WARN = "#fcd34d";

export const createApp = (renderer: CliRenderer, options: Options = {}) => {
const local = options.wgt || null;
const publicLevel = options.level === "Public";
const finish = options.onFinish || ((code: number) => process.exit(code));

const screen = new BoxRenderable(renderer, {
    id: "screen",
    flexDirection: "column",
    padding: 1,
    flexGrow: 1
});

renderer.root.add(screen);

let picker: SelectRenderable | null = null;
let progress: TextRenderable | null = null;

// remove() wants the renderable itself, and each one holds native memory, so it is destroyed
// rather than dropped: these screens are redrawn often enough for the difference to matter.
const clear = () => {
    for (const child of [...screen.getChildren()]) {
        screen.remove(child);
        child.destroyRecursively();
    }

    picker = null;
    progress = null;
};

// Every screen is a list of lines, so there is one way to draw and one place to change it.
const show = (lines: (string | ReturnType<typeof t>)[]) => {
    clear();

    lines.forEach((line, at) => {
        screen.add(new TextRenderable(renderer, { id: `line-${at}`, content: line as any }));
    });

    renderer.requestRender();
};

const heading = (text: string) => t`${bold(fg(ACCENT)(text))}`;
const quiet = (text: string) => t`${dim(text)}`;
const failure = (text: string) => t`${fg(BAD)(text)}`;
const success = (text: string) => t`${fg(GOOD)(text)}`;

const showProgress = (label: string, got: number, total: number) => {
    const text = `  ${bar(got, total)}`;

    if (!progress) {
        show([" ", quiet(`  ${label}`), " ", text]);
        progress = screen.getChildren()[3] as TextRenderable;
        return;
    }

    if (progress.content?.toString() === text) return;

    progress.content = text;
    renderer.requestRender();
};

const bar = (got: number, total: number, width = 32) => {
    const done = total > 0 ? Math.min(1, got / total) : 0;
    const filled = Math.round(done * width);

    return `${"█".repeat(filled)}${"░".repeat(width - filled)}  ${Math.round(done * 100)}%`;
};

// One place decides what a key means, and only the screen that asked for keys gets them.
let onKey: ((name: string) => void) | null = null;

renderer.keyInput.on("keypress", (key: any) => {
    if (key.name === "q" && onKey) return quit(0);
    if (onKey) onKey(key.name);
});

const quit = (code: number) => {
    renderer.destroy();
    finish(code);
};

const waitForEnter = () => new Promise<void>((go) => {
    onKey = (name) => {
        if (name !== "return" && name !== "enter") return;
        onKey = null;
        go();
    };
});

const stumble = async (what: string, error: any) => {
    show([
        failure(what),
        "",
        ...String(error && error.message ? error.message : error).split("\n").map((line) => `  ${line}`),
        "",
        quiet("  Enter to try again  ·  q to give up")
    ]);

    await waitForEnter();
};

const intro = async () => {
    const { primary, others } = await work.addresses();
    const here = primary || "this machine's address";

    const lines: any[] = [
        heading("Tizen Homebrew"),
        "",
        "  On the television, before anything else:",
        "",
        t`    1. Open ${bold("Apps")}, then press ${bold("12345")} (or hold Enter).`,
        t`    2. Turn ${bold("Developer mode")} on.`,
        t`    3. Set ${bold("Host PC IP")} to ${bold(fg(ACCENT)(here))}.`,
        t`    4. ${bold("Restart the television")} — properly, not standby.`,
        "",
        quiet("  That last one matters: the set only reads Host PC IP at startup, so a"),
        quiet("  change without a restart does nothing at all.")
    ];

    if (others.length) {
        lines.push("", quiet(`  This machine also answers to ${others.join(" and ")}, which a`),
            quiet("  television will not reach unless it is on that network."));
    }

    lines.push("", quiet("  Enter when it is back on  ·  q to quit"));

    show(lines);

    await waitForEnter();
};

const choose = async (): Promise<work.Television> => {
    for (;;) {
        show(["", quiet("  looking for televisions...")]);

        const { televisions } = await work.sweep();

        if (!televisions.length) {
            show([
                failure("  Nothing answered."),
                "",
                quiet("  A set has to be on, and on the same network as this machine — a guest"),
                quiet("  network or a VPN is enough to hide it."),
                "",
                quiet("  Enter to look again  ·  q to quit")
            ]);

            await waitForEnter();
            continue;
        }

        const picked = await pick(televisions);

        if (picked.developerOn) return picked;

        show([
            failure(`  ${picked.name} has developer mode off.`),
            "",
            quiet("  Apps > 12345 (or hold Enter) > Settings, turn it on, set Host PC IP,"),
            quiet("  and restart the set."),
            "",
            quiet("  Enter to look again  ·  q to quit")
        ]);

        await waitForEnter();
    }
};

const pick = (televisions: work.Television[]) => new Promise<work.Television>((chosen) => {
    clear();

    screen.add(new TextRenderable(renderer, {
        id: "found",
        content: success(`  Found ${televisions.length === 1 ? "one television" : `${televisions.length} televisions`}.`) as any
    }));

    screen.add(new TextRenderable(renderer, { id: "gap", content: "" }));

    picker = new SelectRenderable(renderer, {
        id: "picker",
        // Each row is its name and its description, so the box needs two lines per television.
        height: Math.min(televisions.length, 6) * 2,
        showDescription: true,
        wrapSelection: true,
        selectedBackgroundColor: ACCENT,
        selectedTextColor: "#0b1220",
        options: televisions.map((tv) => ({
            name: `${tv.name}  ${tv.ip}`,
            description: tv.developerOn ? `${tv.model} · developer mode on` : `${tv.model} · developer mode OFF`,
            value: tv
        }))
    });

    screen.add(picker);

    screen.add(new TextRenderable(renderer, {
        id: "hint",
        content: quiet("\n  ↑↓ to choose  ·  Enter to use it  ·  q to quit") as any
    }));

    picker.focus();

    picker.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: any) => {
        onKey = null;
        chosen(option.value as work.Television);
    });

    renderer.requestRender();
});

const identify = async (tv: work.Television): Promise<string> => {
    show(["", quiet(`  asking ${tv.ip} which device it is...`)]);

    return work.identify(tv.ip);
};

const mint = async (duid: string) => {
    const url = work.signInUrl();

    const render = (opened: boolean) => show([
        heading("  Sign in to Samsung"),
        "",
        "  A certificate has to be issued to your own Samsung account. Open this:",
        "",
        t`    ${fg(ACCENT)(url)}`,
        "",
        quiet(`  This television is ${duid}.`),
        quiet(opened ? "  Opened in your browser  ·  o to open it again  ·  q to quit" : "  o to open it  ·  or copy it in yourself  ·  q to quit"),
        quiet("  Waiting for the browser to come back...")
    ]);

    render(false);

    onKey = (name) => {
        if (name !== "o") return;
        work.openUrl(url);
        render(true);
    };

    try {
        return await work.mint(duid, publicLevel ? "Public" : "Partner");
    } finally {
        onKey = null;
    }
};

const fetchWidget = async () => {
    show(["", quiet("  fetching the widget...")]);

    return work.widget(local, (got, total) => showProgress("fetching the widget", got, total));
};

const installIt = async (tv: work.Television, wgt: Buffer, pair: work.Pair) => {
    show(["", quiet("  signing it for this television...")]);

    const signed = await work.sign(wgt, pair);
    const { primary } = await work.addresses();

    show(["", quiet("  installing...")]);

    return work.install(tv.ip, signed, pair, primary, {
        uploading: (sent, total) => showProgress("installing", sent, total)
    });
};

const done = async (tv: work.Television, version: string) => {
    show([
        success(`  Tizen Homebrew ${version} is installed and open on ${tv.name}.`),
        "",
        "  One last thing, on the television itself:",
        "",
        t`    1. Apps > 12345 (or hold Enter) > Settings: set ${bold("Host PC IP")} to ${bold(fg(ACCENT)("127.0.0.1"))}.`,
        t`    2. ${bold("Restart it")} once more.`,
        "",
        quiet("  That hands installing over to the television itself: from then on it"),
        quiet("  installs from your phone, and this program is never needed again."),
        "",
        quiet("  Enter to finish")
    ]);

    await waitForEnter();
};

const run = async () => {
    await intro();

    for (;;) {
        const tv = await choose();

        try {
            const duid = await identify(tv);

            // Nobody needs a Samsung sign-in to re-install on a set they have already minted for.
            const pair = work.covers(duid) ? work.pair() : await mint(duid);
            const wgt = await fetchWidget();
            const version = await installIt(tv, wgt, pair);

            await done(tv, version);

            return quit(0);
        } catch (error) {
            await stumble(`  ${tv.name} — that did not work.`, error);
        }
    }
};

return { run, intro, choose, pick, done, stumble };
};
