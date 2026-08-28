# Tizen Homebrew

Install apps on a Samsung TV from your phone.

Developer Mode normally points the TV at a computer, which has to stay on the
network and keep the same IP. This points it at `127.0.0.1` instead — the TV
becomes its own developer machine — and puts the interface on your phone.
After the one-time setup below, no computer is involved again.

<img src="logo.png" width="96" align="right">

- Browse and install from a catalogue, a GitHub release, a URL, or a USB stick
- Re-signs every package for your TV, so builds signed by other people install
- A dmesg-style log on the TV screen, for the evening something is wrong
- An sdb shell, from the phone, without a computer on the network

---

## Install it on your TV

You need **Node 20+**, a Samsung TV on the same network, and about ten minutes.

### 1. Turn on Developer Mode

On the TV: **Apps**, then press **12345** on the remote (or hold Enter). Turn
Developer mode **on**, and set **Host PC IP** to *this computer's* address.
Restart the TV — that setting is only read at startup.

### 2. Get the code

```sh
git clone https://github.com/SushyDev/tizen-homebrew.git
cd tizen-homebrew
npm install
```

### 3. Make a certificate for your TV

Samsung binds a signing certificate to one television, identified by its DUID:

```sh
npm run duid -- 192.168.2.9
```

Then mint a pair for it. This opens a Samsung sign-in, waits for the browser,
and writes the result:

```sh
npm run mint -- --duid <the-DUID>
```

That writes `author.p12`, `distributor.p12` and the password into
`~/.tizen-certs`, which is where everything here looks by default.

Both certificates are needed — a Samsung TV rejects the stock Tizen
distributor one — and the DUID has to be right: a pair minted for another set
signs packages that upload fine and are then refused with `Check certificate
error`, a message naming neither the certificate nor the device.

### 4. Build it and put it on the TV

```sh
npm run package
npm run bootstrap -- 192.168.2.9
```

`bootstrap` speaks sdb directly, so there is no Tizen Studio to install. It
opens the app on the TV when it finishes.

### 5. Hand the TV back to itself

On the TV again: **Apps → 12345 → Settings**, set **Host PC IP** to
`127.0.0.1`, and **restart the TV**.

This is the step that makes everything else work, and it cannot be done from
software — sdbd runs a command allowlist and the app sandbox denies spawning
processes. From now on the TV installs its own apps and no other machine can
reach its sdb daemon.

### 6. Open it

Launch Tizen Homebrew on the TV. The screen shows an address and a six-digit
code. Type the address into your phone, type the code, and you are in.

Last thing — send the TV your certificates so it can re-sign what it installs:

```sh
npm run certs -- 192.168.2.9 <the-code-on-screen>
```

---

## Using it

| Tab | What it does |
| --- | --- |
| **Apps** | The catalogue, installed with one press |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo` — takes the newest release |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN changes every time the service starts, and the service starts when the
app is opened. The TV screen always shows the current one.

**Updating** the app later goes over the LAN, since sdb is now closed to
everyone:

```sh
npm run package && npm run push -- 192.168.2.9 <pin>
```

`npm run duid -- 192.168.2.9 <pin>` asks the television through Tizen Homebrew
itself, which works with developer mode pinned to loopback — and says outright
if the certificates on this machine belong to a different set. `npm run mint --
192.168.2.9 <pin>` does the same and mints a pair for whatever it finds, so
neither command needs you to know the DUID.

**If you re-mint your certificates**, the next push is refused with `Author
certificate not match`: Tizen will not update an app across a change of author
certificate. The installed copy has to be removed first, which needs sdb — so
point **Host PC IP** back at your computer, restart the TV, and:

```sh
npm run bootstrap -- 192.168.2.9 --replace
```

Then set it back to `127.0.0.1` and restart again. Tizen Homebrew cannot do
this one for you: removing itself from a TV pinned to loopback would leave
nothing able to reach sdbd, which is why its relay refuses the command.

---

## Re-signing

A Tizen package names the device it may be installed on. Its distributor
certificate carries the binding in plain sight:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

From Tizen 7 the television enforces it, so a package signed by whoever built
it installs on their set and nowhere else. That is why prebuilt `.wgt` files
are not a thing you can hand around, and why step 6 above exists: once the TV
holds a pair minted for it, **every** install is re-signed for it, whatever the
firmware.

Below Tizen 7 it still matters — it is the difference between installing
packages one particular developer signed, and installing packages. Re-signing a
1.8MB package takes about 150ms.

`npm run certs -- <tv-ip> <pin> --forget` removes them again. Nothing reads
them back out: a client can learn that certificates exist and which device they
name, and nothing it could sign with.

---

## The log

Debugging a service on a television is otherwise close to impossible — sdbd's
allowlist excludes every log tool. So press **show logs** on the TV, and:

```
[    0.312] svc: startup finished in 312ms
[    0.906] sdb: loopback 127.0.0.1:26101 answered — this TV can install its own apps
[   38.004] auth: 192.168.2.31 paired
[   54.711] pkg: got tube.wgt: 2.41 MB in 1.61s (1.50 MB/s)
[   59.220] pkg: installed Tube 0.1.0 in 7.22s
```

Up and down move a line, left and right a page, RED jumps to the newest. The
timestamp is monotonic since the service started; the facility says which part
is talking — `svc` `net` `http` `sock` `auth` `dev` `sdb` `pkg` `cat` `relay`
`cfg`.

`GET /logs?since=<seq>` returns the same records as JSON, to loopback or to
anything holding the PIN.

---

## The catalogue

The app list lives in [`catalog/`](catalog/) and is published to GitHub Pages,
which is where the default origin points. Adding an app is a commit there — no
rebuild, and nothing to reinstall on a TV.

```json
{
  "id": "tube",
  "name": "YouTube",
  "description": "YouTube without the advertisements",
  "version": "0.1.0",
  "source": { "type": "github", "ref": "owner/repo" }
}
```

`source.type` is `github` (newest release's first `.wgt`) or `url` (a direct
https link). Malformed entries are dropped rather than trusted, and the list is
cached on disk so a TV with no uplink shows what it last knew.

Point a TV somewhere else without rebuilding by setting `catalogUrl` in
`/home/owner/share/homebrewConfig.json`.

---

## Security

The install endpoint is bound to every interface — that is the point — so it is
gated by the **6-digit PIN** on the TV screen. It is regenerated every start,
never persisted, and `GET /pin` is served only to loopback, so a phone on the
LAN has to be told it by a person. Five wrong guesses locks pairing for five
minutes.

The **sdb relay** is a larger escalation: arbitrary commands as the TV's
developer user. So it is off by default, staying on across reboots is a second
opt-in, commands that would disable the relay or uninstall Tizen Homebrew are
refused, output is capped at 1MB, and every command is logged.

---

## Working on it

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, protocol, PIN gate, install pipeline, re-signing
npm run doctor       # check prerequisites when something looks wrong
```

`npm run dev` serves the television at `/tv.html`, the phone at `/index.html`,
and every screen at once at `/preview.html`. With no TV on the network,
`ui/dev/service.js` answers instead — the real protocol over a real WebSocket,
an install that walks its phases on a timer, and a log to read. Point it at a
real device with `HOMEBREW_TV=192.168.2.9 npm run dev`.

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

Every one of those files opens with why it is the way it is. The build enforces
two platform floors that are easy to trip: the pages are checked against
Chromium 63, which drops CSS it cannot parse *silently*, and the service bundle
against Node 12, measured on Tizen 6.5.

---

## Releasing

Publishing a release or a prerelease on GitHub builds and signs the widget and
attaches it to that release. Set these once, in **Settings → Secrets and
variables → Actions**:

| Kind | Name | |
| --- | --- | --- |
| Secret | `TIZEN_AUTHOR_P12` | `base64 -i ~/.tizen-certs/author.p12 \| pbcopy` |
| Secret | `TIZEN_AUTHOR_PW` | its password |
| Secret | `TIZEN_DISTRIBUTOR_P12` | the same for `distributor.p12` |
| Variable | `HOMEBREW_CATALOG_URL` | optional — overrides the built-in origin |

Tag and version have to agree; `npm run version -- 1.2.0` sets it everywhere.

Remember what those releases are: a widget signed for **your** television. On
Tizen 7 and newer, nobody else's set will install it — they need their own
certificate pair and the steps above.

---

## The look

Both screens are the Wii's Homebrew Channel, rebuilt: an ocean falling from a
lit surface to true black, god rays through it, bubbles rising across the whole
thing, and Frutiger Aero glass panels over the water.

Nothing was eyeballed. Every colour was sampled from the channel's own artwork,
`ui/src/scene/bubbles.js` is a port of `bubbles.c` constant for constant —
including that the number of bubbles follows the time of day — and the theme is
its banner music, cut to loop sample-exactly. See the top of `ui/src/app.css`
and `ui/src/scene/theme.js`, which explain themselves at length.

Credits are on the TV, under **credits**.

---

Licensed GPL-3.0-only. Built on the work in the credits screen — the Homebrew
Channel, TizenBrew, TizenTube, and the people who worked out what a Samsung TV
will and will not allow.
