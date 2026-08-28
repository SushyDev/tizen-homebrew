# Tizen Homebrew

Install apps on a Samsung TV from your phone.

<img src="icon.png" width="96" align="right">

Developer Mode normally points a TV at a computer that has to stay on the
network. This points it at `127.0.0.1` — the TV becomes its own developer
machine — and puts the interface on your phone. Set it up once; no computer
after that.

- Install from a catalogue, a GitHub release, a URL, or a USB stick
- Re-signs every package for your TV, so builds signed by other people install
- A dmesg-style log on the TV screen
- An sdb shell, from the phone

---

## Install

**Node 20+**, a Samsung TV on the same network, ten minutes. Use your TV's
address in place of `192.168.2.9`.

**1 · On the TV.** **Apps** → press **12345** (or hold Enter) → Developer mode
**on**, **Host PC IP** = *this computer's address*. **Restart the TV.**

**2 · On your computer.**

```sh
git clone https://github.com/SushyDev/tizen-homebrew.git
cd tizen-homebrew
npm install
npm run full-bootstrap -- 192.168.2.9
```

It asks the TV which device it is, mints a Samsung certificate bound to it (a
browser opens — sign in), then builds, signs, installs and opens the app. No
Tizen Studio needed. The certificate is yours — your own Samsung account,
public level, nothing shared — and lands in `~/.tizen-certs`.

**3 · On the TV again.** **Apps** → **12345** → **Settings**, **Host PC IP** =
`127.0.0.1`. **Restart the TV.**

This is the step that makes the rest work, and no software can do it for you —
sdbd runs a command allowlist. From here the TV installs its own apps and no
other machine can reach its sdb daemon.

**4 · On your phone.** Open Tizen Homebrew on the TV. Its screen shows an
address and a 6-digit code; type both into your phone.

**5 · One last command,** with that same code:

```sh
npm run certs -- 192.168.2.9 <code>
```

Now the TV re-signs whatever it installs, so packages built by other people
work on it. Done.

---

## Using it

| Tab | |
| --- | --- |
| **Apps** | The catalogue, installed with one press |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo` — takes the newest release |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN changes every time the app is opened; the TV screen shows the current
one. Update Tizen Homebrew itself over the LAN:

```sh
npm run package && npm run push -- 192.168.2.9 <pin>
```

---

## Commands

| | |
| --- | --- |
| `npm run full-bootstrap -- <ip>` | Certificate, build, install — the whole setup |
| `npm run mint -- <ip> [pin]` | Certificate only; adds this TV to the pair you have |
| `npm run package` | Build and sign a `.wgt` |
| `npm run bootstrap -- <ip>` | Install over sdb (needs Host PC IP pointed here) |
| `npm run push -- <ip> <pin>` | Install over the LAN, once the app is running |
| `npm run certs -- <ip> <pin>` | Give the TV its certificates (`--forget` removes) |
| `npm run duid -- <ip> [pin]` | Print the device id a certificate binds to |
| `npm run doctor` | Check prerequisites when something looks wrong |

Given the PIN, `mint` `certs` `duid` `push` all work with the TV pinned to
`127.0.0.1`. `bootstrap` cannot — it needs sdbd, which is what a pinned set
stops answering.

**When it goes wrong**

| The message | What to do |
| --- | --- |
| `Check certificate error … Invalid signature` | Your pair does not cover this TV — `npm run mint -- <ip>` |
| `Author certificate not match` | The author certificate changed — `npm run bootstrap -- <ip> --replace` |
| `accepted the connection then dropped it` | Host PC IP is not this machine. Set it, restart the TV. |

**More than one TV.** One pair covers as many as you like: point `mint` at the
next set and it adds that device. The author certificate is kept, and that
matters — Tizen refuses to update an app whose author changed, and the way out
is an uninstall over sdb, which means a walk to every TV you already had.

---

## How it works

**Re-signing.** A Tizen package names the device it may be installed on, in its
distributor certificate:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

From Tizen 7 the TV enforces it, so a `.wgt` installs on its builder's set and
nowhere else. That is why prebuilt widgets are not something you can hand
around, and why step 5 exists: a TV holding its own pair re-signs everything it
installs, in about 150ms.

**Security.** The install endpoint is open to the network on purpose, so it is
gated by the 6-digit PIN — regenerated every start, never persisted, and
readable only over loopback, so a person has to relay it. Five wrong guesses
locks pairing for five minutes. The sdb relay is a bigger escalation: off by
default, a second opt-in to survive reboots, and it refuses commands that would
disable it or uninstall the app.

**The log.** sdbd's allowlist excludes every log tool, so the app carries its
own. Press **show logs** on the TV; up/down a line, left/right a page, RED for
newest. `GET /logs?since=<seq>` returns the same records as JSON.

```
[    0.906] sdb: loopback 127.0.0.1:26101 answered — this TV can install its own apps
[   59.220] pkg: installed Tube 0.1.0 in 7.22s
```

**The catalogue.** The app list is [`catalog/`](catalog/), published to GitHub
Pages. Adding an app is a commit there — no rebuild, nothing to reinstall.
`source.type` is `github` (newest release's first `.wgt`) or `url`.

```json
{
  "id": "tube",
  "name": "YouTube",
  "description": "YouTube without the advertisements",
  "version": "0.1.0",
  "source": { "type": "github", "ref": "owner/repo" }
}
```

A `github` app's logo is `logo.png` in the root of its own repository, guessed
rather than declared — `icon` overrides it with an https URL. An app with
neither gets a monogram, and nothing else changes.

**What a package says it is.** Everything else on the phone shows the
application rather than the file it arrived in: its name, its version, the id
it installs under and its own icon, read straight out of the archive. A stick
plugged into the TV is listed that way, and so is anything mid-install, the
moment the bytes are in hand. A `.wgt` chosen for upload is opened on the phone
itself — see `ui/src/core/package.js` — so you can see what it is before
sending a megabyte of it anywhere.

---

## Working on it

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, protocol, PIN gate, install pipeline, re-signing
```

`npm run dev` serves the TV at `/tv.html`, the phone at `/index.html`, both at
`/preview.html`. With no TV around, `ui/dev/service.js` answers — real protocol,
real WebSocket. Point it at hardware with `HOMEBREW_TV=192.168.2.9 npm run dev`.

| Path | |
| --- | --- |
| `ui/src/views/television.js` | The TV screen: readouts, log console, credits |
| `ui/src/views/screens.js` | The phone UI |
| `ui/src/app.css` | The design system, one file |
| `ui/src/core/remote.js` | D-pad focus, so the TV page works by remote |
| `service/src/main.js` | Routes, and what the service is |
| `service/src/install/pipeline.js` | Install, six named steps |
| `service/src/install/resign.js` | Re-signing for this television |
| `service/src/tv/sdb.js` | Loopback sdb with real timeouts |
| `service/src/obs/log.js` | The log everything else writes to |

Every one of those, and every tool in [`tools/`](tools/), opens with why it is
the way it is. Two platform floors are easy to trip and the build enforces
both: pages against Chromium 63, which drops CSS it cannot parse *silently*,
and the service bundle against Node 12.

**Releasing.** Publishing a GitHub release builds, signs and attaches the
widget. Set once under **Settings → Secrets and variables → Actions**:
`TIZEN_AUTHOR_P12`, `TIZEN_AUTHOR_PW`, `TIZEN_DISTRIBUTOR_P12` as secrets (the
p12s base64-encoded, plus `TIZEN_DISTRIBUTOR_PW` if it differs), and optionally
`HOMEBREW_CATALOG_URL` as a variable. Tag and
version have to agree — `npm run version -- 1.2.0` sets it everywhere. Those
releases are signed for **your** television and nobody else's.

---

## The look

Both screens are the Wii's Homebrew Channel, rebuilt: an ocean falling from a
lit surface to true black, god rays, bubbles, Frutiger Aero glass over the
water. Nothing was eyeballed — every colour is sampled from the channel's own
artwork, `ui/src/scene/bubbles.js` ports `bubbles.c` constant for constant, and
the theme is its banner music cut to loop sample-exactly. Credits are on the TV.

---

Licensed GPL-3.0-only. Built on the work in the credits screen — the Homebrew
Channel, TizenBrew, TizenTube, and the people who worked out what a Samsung TV
will and will not allow.
