// The entry point: read the flags, make a real renderer, hand both to the screens.

import { createCliRenderer } from "@opentui/core";

import { createApp } from "./app.js";
import * as work from "./work.js";

// The plain listing, for a terminal that cannot draw and for checking the sweep by itself.
if (process.argv.indexOf("--list") !== -1) {
    const { televisions, prefixes } = await work.sweep();

    for (const prefix of prefixes) console.log(`swept ${prefix}.0/24`);

    for (const tv of televisions) {
        console.log(`  ${tv.ip.padEnd(16)} ${tv.name.padEnd(24)} ${tv.model.padEnd(16)} ${tv.developerOn ? "developer mode on" : "developer mode OFF"}`);
    }

    process.exit(televisions.length ? 0 : 1);
}

const at = process.argv.indexOf("--wgt");

const renderer = await createCliRenderer({ exitOnCtrlC: true, clearOnShutdown: true });

const app = createApp(renderer, {
    wgt: at === -1 ? null : process.argv[at + 1] || null,
    level: process.argv.indexOf("--public") === -1 ? "Partner" : "Public"
});

app.run().catch((error) => {
    renderer.destroy();
    console.error(error);
    process.exit(1);
});
