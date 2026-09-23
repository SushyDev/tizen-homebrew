// Everything the installer does that is not drawing. None of it is new: the sweep, the minting, the
// re-signer and the install all belong to this repository already, and several of them run on the
// television itself. This file only puts them in order and hands back plain results for the screens
// to render.

import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

// Imported rather than required: the bundler has to see these to put them in the binary, and a
// createRequire call is opaque to it — the compiled program then looks for them on a disk that has
// no checkout on it.
import discover from "../../tools/discover.js";
import minting from "../../tools/minting.js";
import installing from "../../tools/installing.js";
import certificates from "../../tools/certificates.js";
import tv from "../../tools/tv.js";
import resigner from "../../service/src/install/resign.js";

const { duidOf } = tv;
const { resign } = resigner;

// Where a release keeps the widget. Unsigned on purpose: a signature names one television, so the
// installer signs it here with the pair it just minted.
const LATEST = "https://api.github.com/repos/SushyDev/tizen-homebrew/releases/latest";

export type Television = {
    ip: string;
    name: string;
    model: string;
    developerOn: boolean;
};

export type Pair = {
    author: { certificates: string[]; key: string };
    distributor: { certificates: string[]; key: string };
    devices: string[];
};

const friendly = (message: string) => Object.assign(new Error(message), { isFriendly: true });

export const addresses = async (): Promise<{ primary: string | null; others: string[] }> => {
    const interfaces = networkInterfaces();
    const found: string[] = [];

    for (const name of Object.keys(interfaces)) {
        for (const entry of interfaces[name] || []) {
            if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
        }
    }

    // A machine with a VM bridge or a VPN has several addresses and only one of them is reachable
    // from a television, so the routed one leads and the rest are a footnote. Connecting a UDP
    // socket sends no packets; it only asks the routing table to choose.
    const routed = await new Promise<string | null>((resolve) => {
        try {
            const socket = createSocket("udp4");

            socket.once("error", () => resolve(null));

            socket.connect(80, "8.8.8.8", () => {
                const chosen = socket.address().address;
                socket.close();
                resolve(chosen || null);
            });
        } catch (e) {
            resolve(null);
        }
    });

    const primary = routed && found.indexOf(routed) !== -1 ? routed : found[0] || null;

    return { primary, others: found.filter((ip) => ip !== primary) };
};


export const sweep = async (): Promise<{ televisions: Television[]; prefixes: string[] }> => {
    const { televisions, prefixes } = await discover.sweep();

    return {
        prefixes,
        televisions: televisions.map((found: any) => ({
            ip: found.ip,
            name: discover.nameOf(found.device),
            model: found.device.modelName || found.device.model || "",
            developerOn: found.device.developerMode === "1"
        }))
    };
};

// The honest test that the television will accept an install: sdbd answers this machine, and says
// which device it is. Both are needed before a certificate can be minted for it.
export const identify = async (ip: string): Promise<string> => {
    const duid = await duidOf(ip);

    if (!duid) {
        throw friendly(
            "That set did not answer over sdb.\n\n" +
            "Its Host PC IP has to be this machine, and it only reads that at startup —\n" +
            "so if it was just changed, the television needs restarting."
        );
    }

    return duid;
};

export const signInUrl = (): string => minting.SIGN_IN;

// Clicking a link is inconsistent across terminal emulators, so screens can open one themselves.
export const openUrl = (url: string): void => {
    const [command, args]: [string, string[]] = process.platform === "darwin" ? ["open", [url]]
        : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

    try {
        spawn(command, args, { stdio: "ignore", detached: true }).unref();
    } catch (e) { /* the printed URL is the only fallback */ }
};

// A pair already naming this television signs for it, and Samsung has nothing to add. Worth asking
// before sending anyone to a browser.
export const covers = (duid: string): boolean => {
    const existing = certificates.locate();

    if (certificates.missing(existing).length) return false;

    return certificates.devicesIn(existing.distributor, existing.distributorPassword).indexOf(duid) !== -1;
};

// Waits for the browser to come back from Samsung, then asks for a pair naming this television.
export const mint = async (duid: string, level: "Partner" | "Public"): Promise<Pair> => {
    const account = await minting.signIn();

    const existing = certificates.locate();
    const covered = certificates.devicesIn(existing.distributor, existing.distributorPassword);
    const keeping = Boolean(existing.password) && covered.length > 0;

    const devices = covered.indexOf(duid) === -1 ? covered.concat(duid) : covered;
    const password = Math.random().toString(36).slice(2, 12);

    const minted = await minting.mint(account, {
        name: (account.email || "tizen-homebrew").split("@")[0],
        email: account.email,
        password: keeping ? existing.password : password,
        privilegeLevel: level
    }, devices, keeping);

    minting.write(certificates.DEFAULT_DIR, minted, keeping, password, existing);

    return pair();
};

// The PEM form both the re-signer and the television want.
export const pair = (): Pair => {
    const found = certificates.locate();
    const absent = certificates.missing(found);

    if (absent.length) throw friendly(`No certificate to sign with:\n\n  ${absent.join("\n  ")}`);

    return {
        author: certificates.asPem(readFileSync(found.author), found.password),
        distributor: certificates.asPem(readFileSync(found.distributor), found.distributorPassword),
        devices: certificates.devicesIn(found.distributor, found.distributorPassword)
    };
};

// The widget itself, from the newest release — or a local file, which is how this gets tested
// before there is a release to download.
export const widget = async (local: string | null, onProgress?: (got: number, total: number) => void): Promise<Buffer> => {
    if (local) return readFileSync(local);

    const release = await fetch(LATEST, { headers: { accept: "application/vnd.github+json" } });

    if (!release.ok) throw friendly(`GitHub would not say what the latest release is (${release.status}).`);

    const assets = ((await release.json()) as any).assets || [];
    const asset = assets.find((item: any) => String(item.name).endsWith(".wgt"));

    if (!asset) throw friendly("The latest release carries no .wgt to install.");

    const download = await fetch(asset.browser_download_url);

    if (!download.ok || !download.body) throw friendly(`Could not download ${asset.name} (${download.status}).`);

    const total = Number(download.headers.get("content-length") || asset.size || 0);
    const chunks: Uint8Array[] = [];
    let got = 0;

    for await (const chunk of download.body as any) {
        chunks.push(chunk);
        got += chunk.length;
        if (onProgress) onProgress(got, total);
    }

    return Buffer.concat(chunks);
};

// The television's own re-signer, run here instead of there, because there is nothing installed on
// it yet to do the signing.
export const sign = async (archive: Buffer, using: Pair): Promise<Buffer> => {
    const { archive: signed } = await resign(archive, using);

    return signed;
};

export type InstallEvents = {
    uploading?: (sent: number, total: number) => void;
    installed?: (version: string) => void;
};

export const install = async (ip: string, wgt: Buffer, using: Pair, mine: string | null, events: InstallEvents): Promise<string> => {
    const manifest = await installing.manifestIn(wgt);
    const { packageId, appId } = installing.idsIn(manifest);

    const session = await installing.connect(ip, mine);

    try {
        const result = await installing.install(session, {
            ip,
            wgt,
            packageId,
            appId,
            profile: profile(),
            replace: false,
            on: { progress: events.uploading }
        });

        if (events.installed) events.installed(result.version || "?");

        // Left where the service adopts them on first start, so nobody has to read a PIN off the
        // television and send the pair by hand.
        await installing.handOff(session, using);

        await installing.launchApp(ip, appId);

        return result.version || "?";
    } finally {
        session.close();
    }
};

// The distributor profile minting writes beside the pair. Without it on the television a correctly
// signed package is refused with a security error that names neither.
const profile = (): Buffer | null => {
    const beside = join(dirname(certificates.locate().author), "device-profile.xml");

    try {
        return readFileSync(beside);
    } catch (e) {
        return null;
    }
};
