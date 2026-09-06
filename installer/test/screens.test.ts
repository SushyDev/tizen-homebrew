// The screens, rendered to plain characters and read back. A terminal interface is still text, so
// there is no reason to check it by looking at it.

import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createApp } from "../src/app.js";

const frame = async (draw: (app: ReturnType<typeof createApp>) => void) => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 90, height: 30 });

    draw(createApp(renderer, { wgt: "unused", onFinish: () => {} }));

    // The first screen asks the routing table which address to name, so let that settle.
    await new Promise((ready) => setTimeout(ready, 60));

    await renderOnce();

    return captureCharFrame();
};

test("the first screen says what to change on the television", async () => {
    const shown = await frame((app) => { app.intro(); });

    expect(shown).toContain("Tizen Homebrew");
    expect(shown).toContain("Open Apps, then press 12345");
    expect(shown).toContain("Turn Developer mode on");
    expect(shown).toContain("Set Host PC IP to");
    expect(shown).toContain("Restart the television");
    expect(shown).toContain("Enter when it is back on");
});

test("the picker lists a television with its address and mode", async () => {
    const shown = await frame((app) => {
        app.pick([
            { ip: "192.168.1.29", name: "65\" OLED", model: "QE65S93DATXXN", developerOn: true },
            { ip: "192.168.1.94", name: "Living room", model: "QE55S95BATXXN", developerOn: false }
        ]);
    });

    expect(shown).toContain("Found 2 televisions");
    expect(shown).toContain("65\" OLED");
    expect(shown).toContain("192.168.1.29");
    expect(shown).toContain("developer mode on");
    expect(shown).toContain("developer mode OFF");
});

// Every screen after the first tears the previous one down, and that path had no test at all: the
// installer fell over on the very first Enter because remove() was being handed an id.
test("moving from one screen to the next tears the first one down", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 90, height: 30 });

    const app = createApp(renderer, { wgt: "unused", onFinish: () => {} });

    app.intro();
    await new Promise((ready) => setTimeout(ready, 60));
    await renderOnce();

    app.pick([{ ip: "192.168.1.29", name: "65\" OLED", model: "QE65S93DATXXN", developerOn: true }]);
    await renderOnce();

    const shown = captureCharFrame();

    expect(shown).toContain("Found one television");
    expect(shown).not.toContain("Restart the television");
});

test("the last screen asks for the setting to be put back", async () => {
    const shown = await frame((app) => {
        app.done({ ip: "192.168.1.29", name: "65\" OLED", model: "QE65S93DATXXN", developerOn: true }, "0.1.8");
    });

    expect(shown).toContain("is installed and open");
    expect(shown).toContain("127.0.0.1");
    expect(shown).toContain("Restart it");
});
