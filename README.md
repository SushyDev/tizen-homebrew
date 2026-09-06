# Tizen Homebrew

Install apps on a Samsung TV from your phone.

<img src="icon.png" width="96" align="right">

Developer Mode normally points a TV at a computer that has to stay on the
network. This points it at `127.0.0.1` — the TV becomes its own developer
machine — and puts the interface on your phone. Set it up once; no computer
after that.

- Install from a catalog, a GitHub release, a URL, or a USB stick
- Re-signs every package for your TV, so builds signed by other people install
- A dmesg-style log on the TV screen
- An sdb shell, from the phone

**Discord**: https://discord.gg/WjxVnrsV4A

---

## Install

One command. It carries its own runtime, so nothing has to be installed first.

```sh
curl -fsSL https://sushydev.github.io/tizen-homebrew/install.sh | sh
```

```powershell
irm https://sushydev.github.io/tizen-homebrew/install.ps1 | iex
```

It tells you what to switch on, finds the TV, mints a Samsung certificate
against your own account, installs the app, and tells you what to switch back.
Ten minutes, most of it spent restarting the TV.

Two steps are yours: sdbd runs a command allowlist, so no software can do them.
Both are **Apps** → **12345** (or hold Enter) → **Settings**, and both need a
restart, since that value is only read at startup.

| When | Set **Host PC IP** to |
| --- | --- |
| Before installing | this computer's address — the installer prints it |
| After installing | `127.0.0.1` |

The second makes the rest work: the TV then installs its own apps, and no other
machine can reach its sdb daemon.

**From a checkout**, with Node 20+:

```sh
git clone https://github.com/SushyDev/tizen-homebrew.git
cd tizen-homebrew
npm install
npm run full-bootstrap          # or: -- <tv-ip>, if you know it
```

Same flow, built from source. It mints a **Partner** certificate — yours, your
account, nothing shared — into `~/.tizen-certs`; `--public` mints a public one,
which installs the same but carries no on-boot service. The certificates go to
the TV as well, so from first boot it re-signs whatever it installs, including
packages built by other people.

---

## Screens

<table>
<tr>
<td width="75%" valign="top">

https://github.com/user-attachments/assets/a5960e36-27b7-4ed9-9445-98849855682b
</td>
<td width="25%" valign="top">

https://github.com/user-attachments/assets/c176baef-5690-414c-95a5-7e968464a860
</td>
</tr>
<tr>
<td align="center"><sub>▶ The television — 37s · pairing, an install as it lands, the log console, the credits</sub></td>
<td align="center"><sub>▶ The phone — 33s</sub></td>
</tr>
</table>

### On the TV

<table>
<tr>
<td><img src="media/tv-screen.webp" alt="The television screen: the address to open, the pairing code, and the log"></td>
</tr>
<tr>
<td align="center"><sub>The address, the code, and whatever the service is doing</sub></td>
</tr>
</table>

<table>
<tr>
<td width="33%"><img src="media/tv-installing.webp" alt="The log narrating an install"></td>
<td width="33%"><img src="media/tv-logs.webp" alt="The log console"></td>
<td width="33%"><img src="media/tv-credits.webp" alt="The credits"></td>
</tr>
<tr>
<td align="center"><sub>An install, as it happens</sub></td>
<td align="center"><sub>The log console</sub></td>
<td align="center"><sub>Credits</sub></td>
</tr>
</table>

### On the phone

<table>
<tr>
<td width="33%"><img src="media/phone-pairing.webp" alt="Pairing"></td>
<td width="33%"><img src="media/phone-apps.webp" alt="The catalog"></td>
<td width="33%"><img src="media/phone-updates.webp" alt="Updates found"></td>
</tr>
<tr>
<td align="center"><sub><b>Pairing</b> — the six digits on the TV</sub></td>
<td align="center"><sub><b>Apps</b> — the catalog, and what is already on the TV</sub></td>
<td align="center"><sub><b>check all</b> — what has a newer release</sub></td>
</tr>
<tr>
<td><img src="media/phone-upload.webp" alt="Upload"></td>
<td><img src="media/phone-github.webp" alt="GitHub"></td>
<td><img src="media/phone-usb.webp" alt="USB"></td>
</tr>
<tr>
<td align="center"><sub><b>Upload</b> — a .wgt from the phone</sub></td>
<td align="center"><sub><b>GitHub</b> — owner/repo, newest release</sub></td>
<td align="center"><sub><b>USB</b> — a stick plugged into the TV</sub></td>
</tr>
<tr>
<td><img src="media/phone-shell.webp" alt="Shell"></td>
<td><img src="media/phone-installing.webp" alt="Installing"></td>
<td><img src="media/phone-installed.webp" alt="Installed"></td>
</tr>
<tr>
<td align="center"><sub><b>Shell</b> — sdb commands, off by default</sub></td>
<td align="center"><sub>Five steps, re-signing among them</sub></td>
<td align="center"><sub>On the TV's home row</sub></td>
</tr>
</table>

---

## Using it

| Tab | |
| --- | --- |
| **Apps** | The catalog, installed with one press |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo` — takes the newest release |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN changes every time the app opens, and the TV screen shows the current
one. Your phone keeps the last one that worked until the TV restarts.

**Updates.** Every **Apps** row says whether it is installed and at which
version. Whether anything newer was *released* is a GitHub request per app, so
it waits to be asked: **check** on a row, or **check all** under the list.
Tizen Homebrew is in its own catalog, so it updates itself the same way. From a
working copy, over the LAN:

```sh
npm run package && npm run push -- <tv-ip> <pin>
```

---

## Commands

| | |
| --- | --- |
| `npm run full-bootstrap [-- <ip>]` | Certificate, build, install — the whole setup. Finds the TV itself if you do not name one |
| `npm run mint -- <ip> [pin]` | Certificate only; adds this TV to the pair you have |
| `npm run package` | Build a `.wgt` signed by nobody — what a release carries |
| `npm run package -- --sign` | The same, signed for this machine's TV — what sdb needs |
| `npm run bootstrap -- <ip>` | Install over sdb (needs Host PC IP pointed here) |
| `npm run push -- <ip> <pin>` | Install over the LAN, once the app is running |
| `npm run certs -- <ip> <pin>` | Re-send the TV's certificates (`--forget` removes) |
| `npm run duid -- <ip> [pin]` | Print the device id a certificate binds to |
| `npm run repl -- <ip>` | A prompt inside the running service — developer builds only |
| `npm run doctor` | Check prerequisites when something looks wrong |

`mint` `certs` `duid` `push` all work with the TV pinned to `127.0.0.1`, given
the PIN. `bootstrap` cannot: it needs the sdbd a pinned set stops answering.
Both certificate commands take `--public`.

**Developer builds.** `--dev` fixes the PIN at `000000` and puts a prompt inside
the service, so a build pushed every few minutes stops asking for a code off the
screen:

```sh
npm run package -- --dev && npm run push -- <tv-ip> 000000
npm run repl -- <tv-ip>
```

Every line is evaluated in the running service — `store.get()`, `await
packages.list()`; `.inspect` opens Node's inspector for Chrome DevTools, and
`.names` lists what is in scope. That is arbitrary code execution as the
service, reachable by anything on the network, so an ordinary build carries no
`/dev` routes: the bundler drops the branch, and `--release` refuses a developer
build outright.

**When it goes wrong**

| The message | What to do |
| --- | --- |
| `Check certificate error … Invalid signature` | Your pair does not cover this TV — `npm run mint -- <ip>` |
| `Author certificate not match` | The author certificate changed — `npm run bootstrap -- <ip> --replace` |
| `accepted the connection then dropped it` | Host PC IP is not this machine. Set it, restart the TV. |

**More than one TV.** One pair covers as many as you like: point `mint` at the
next set and it adds that device, keeping the author certificate. That matters —
Tizen refuses to update an app whose author changed, and the way out is an
uninstall over sdb at every TV you already had.

---

## How it works

**Re-signing.** A Tizen package names the device it may be installed on, in its
distributor certificate:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

From Tizen 7 the TV enforces it, so a `.wgt` installs on its builder's set and
nowhere else. Prebuilt widgets therefore cannot be handed around, and the TV is
given its own pair during setup: a set holding one re-signs everything it
installs, in about 150ms.

**Always on.** `config.xml` declares the service `on-boot` and `auto-restart`, so
it comes up with the television: switch the set on, load the address on a phone,
install. The app remains for the log, the pairing code and a restart button, and
closing it leaves the service running. Confirmed on a QE65S93DATXXN under a
partner certificate; both attributes are documented as partner and platform only,
whether a public pair gets them is untested, and dropping them returns the
service to starting when the app opens.

**Security.** The install endpoint is deliberately open to the network, gated by
the 6-digit PIN: minted on first run, kept beside the signing keys, readable only
over loopback so a person has to relay it. Keeping it rather than regenerating
means a reboot neither unpairs every phone nor leaves the code readable only off
the screen the service exists to avoid. Phones store it per TV and drop it when
refused; five wrong guesses locks pairing for five minutes. The sdb relay is off
by default, takes a second opt-in to survive reboots, and refuses commands that
would disable it or uninstall the app.

**The log.** sdbd's allowlist excludes every log tool, so the app carries its
own. Press **show logs** on the TV; up/down a line, left/right a page, RED for
newest. `GET /logs?since=<seq>` returns the same records as JSON.

```
[    0.906] sdb: loopback 127.0.0.1:26101 answered — this TV can install its own apps
[   59.220] pkg: installed Tube 0.1.0 in 7.22s
```

**The catalog.** The app list is [`catalog/`](catalog/), published to GitHub
Pages. Adding an app is a commit there — no rebuild, nothing to reinstall.
`source.type` is `github` (newest release's first `.wgt`) or `url`. A `github`
app's logo is `logo.png` in its repository root, guessed rather than declared;
`icon` overrides it with an https URL, and an app with neither gets a monogram.

```json
{
  "id": "tube",
  "name": "YouTube",
  "description": "YouTube without the advertisements",
  "packageId": "tUb3Xq7Lm9",
  "source": { "type": "github", "ref": "owner/repo" }
}
```

**Updates.** `packageId` is the id an app installs under, and how a row knows it
is already on the TV: the platform answers that for every app at once, locally,
so the list never waits. Released versions are one GitHub request each — too much
for a two-hundred-app catalog on the way to a screen — so that half is a button:
three at a time, cached six hours, stopping early if GitHub starts refusing. Only
strictly newer by semver lights **update**; anything else gets a blocked button
and a line saying whether it is current or unchecked.

**What a package says it is.** The phone shows the application rather than the
file it arrived in — name, version, install id and icon, read out of the archive
— covering a stick plugged into the TV and anything mid-install, the moment the
bytes are in hand. A `.wgt` chosen for upload is opened on the phone itself
(`ui/src/core/package.js`), so you can see what it is before sending it.

---

## Working on it

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, protocol, PIN gate, install pipeline, re-signing
```

`npm run dev` serves the TV at `/tv.html`, the phone at `/index.html`, both at
`/preview.html`. With no TV around `ui/dev/service.js` answers, real protocol
over a real WebSocket; `HOMEBREW_TV=<tv-ip> npm run dev` points it at hardware.

The installer is a separate program in [`installer/`](installer/): Bun and
OpenTUI, compiled to one binary per platform. It calls `tools/` and `service/`
directly rather than reimplementing them, so the sdb client and the re-signer
have one implementation each.

```sh
cd installer && bun install && npm run natives   # every platform's renderer
bun run start                                    # or: --wgt <path>, --public
bun test
```

| Path | |
| --- | --- |
| `ui/src/views/television.js` | The TV screen: readouts, log console, credits |
| `ui/src/views/screens.js` | The phone UI |
| `ui/src/app.css` | The design system, one file |
| `ui/src/core/remote.js` | D-pad focus, so the TV page works by remote |
| `service/src/main.js` | Routes, and what the service is |
| `service/src/install/pipeline.js` | Install, six named steps |
| `service/src/install/resign.js` | Re-signing for this television |
| `service/src/install/updates.js` | What is installed, and what has been released since |
| `service/src/install/versions.js` | Semver, to the extent a release tag has one |
| `service/src/tv/sdb.js` | Loopback sdb with real timeouts |
| `service/src/obs/log.js` | The log everything else writes to |
| `installer/src/work.ts` | The installer's steps, calling the above |

Every one of those, and every tool in [`tools/`](tools/), opens with why it is
the way it is. The build enforces two platform floors that are easy to trip:
pages against Chromium 63, which drops CSS it cannot parse *silently*, and the
service bundle against Node 12.

**Releasing.** Pushing a tag builds the widget and the five installer binaries
and opens a draft release with them attached. Tag and version have to agree:

```sh
npm run version:set 1.2.0    # and commit
git tag v1.2.0 && git push origin v1.2.0
```

Publishing the draft is the last step and the one that offers the update: drafts
are invisible to `releases/latest`, which every TV and install script asks. The
widget is **unsigned** — a signature names one television, and every Tizen
Homebrew re-signs what it installs anyway, including itself. No secrets needed;
`HOMEBREW_CATALOG_URL` as a repository variable overrides the catalog origin.

---

## The look

Both screens are the Wii's Homebrew Channel, rebuilt: an ocean falling from a
lit surface to true black, god rays, bubbles, Frutiger Aero glass over the
water. Nothing was eyeballed — every color is sampled from the channel's own
artwork, `ui/src/scene/bubbles.js` ports `bubbles.c` constant for constant, and
the theme is its banner music cut to loop sample-exactly. Credits are on the TV.

---

Licensed GPL-3.0-only. Built on the work in the credits screen — the Homebrew
Channel, TizenBrew, TizenTube, and the people who worked out what a Samsung TV
will and will not allow.
