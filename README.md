# Tizen Homebrew

Install apps on a Samsung Tizen TV from your phone. Developer Mode gets pinned
to `127.0.0.1` once and never touched again — no laptop in the path, so its
changing IP stops mattering.

```
phone browser  ──http://<tv-ip>:8091──▶  Tizen Homebrew (on the TV)
                                              │
                                              ├─ probe  127.0.0.1:8001  (dev-mode state)
                                              ├─ fetch  catalog / GitHub release
                                              ├─ resign (Tizen 7+ only)
                                              ├─ stage  /home/owner/share/tmp/sdk_tools/
                                              └─ install 127.0.0.1:26101 → vd_appinstall
```

The television shows the address and a pairing code; everything else happens on
the phone. Two screens, one service, no computer after the first install.

---

## Quickstart

```sh
npm install
npm run build
npm test
```

About ten seconds from a fresh clone. You need **Node 20+** (see `.nvmrc`) and
nothing else installed globally. If anything looks wrong, run `npm run doctor`
first — it checks every prerequisite and says what to do about each one.

| Command | What it does |
| --- | --- |
| `npm run doctor` | Check prerequisites and config. Start here when something breaks. |
| `npm run build` | Build both pages and the service bundle. |
| `npm test` | Lint, then every service suite. |
| `npm run package` | Build, then sign `release/tizenhomebrew.wgt`. Needs certificates. |
| `npm run bootstrap -- <tv-ip>` | First install onto a TV, over sdb. Needed once. |
| `npm run duid -- <tv-ip>` | The TV's DUID, which is what a certificate is bound to. |
| `npm run certs -- <tv-ip> <pin>` | Send this machine's certificate pair to the TV, so it can re-sign. |
| `npm run push -- <tv-ip> <pin>` | Install over the LAN, through Tizen Homebrew itself. |
| `npm run dev` | Both screens in a browser, live, with no hardware. |
| `npm run dev:service` | Run the service off-TV on `:8091`. |
| `npm run version -- 1.2.3` | Set the version everywhere it appears. |
| `npm run clean` | Remove build output. `-- --all` also drops `node_modules`. |

---

## How it works

Enabling Developer Mode starts `sdbd` on port **26101**, which accepts
connections only from the IP configured as the developer host. Set that host to
**`127.0.0.1`** and the TV accepts SDB connections *from itself*, so a service
running inside a `.wgt` can install packages with nothing else involved.

Readiness is read from the TV's own Smart View REST API on port **8001**, which
always runs, needs no auth from localhost, and reports both `developerMode` and
`developerIP`. Some firmwares byte-swap the address and report `1.0.0.127`;
both forms are accepted.

Installation is `shell:0 vd_appinstall <packageId> <path>` over that loopback
SDB connection. The command leaves its stream open after finishing, so success
is read from the output (`spend time`) rather than from the stream ending.

Tizen 3 has no SDB path available to a service, but is privileged enough to
call `wascmd` and to write the developer settings directly through `buxton2ctl`.

### Re-signing, and why every install goes through it

A Tizen package names the device it may be installed on. Its distributor
certificate carries the binding in plain sight:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

From Tizen 7 the television enforces it, so a package signed by whoever built
it installs on their set and nowhere else — which is the single reason a
channel cannot simply hand out `.wgt` files. Tizen Homebrew answers by
re-signing what it installs, for the TV it is running on:

```sh
npm run duid  -- 192.168.2.9          # which device is this?
npx tizenjs create-samsung-cert --privilege Public \
  --name <you> --email <you@example.com> --password <password> \
  --duidList <TV-DUID> --output ~/.tizen-certs
npm run certs -- 192.168.2.9 <pin>    # send the pair to the TV
```

After that the TV holds the pair in `/home/owner/share/homebrewConfig.json`
and **every** install is re-signed — not only on the firmwares that insist.
Below Tizen 7 the difference is between installing "packages this one
developer signed" and installing packages: an unsigned build, or one signed
for somebody else's television, is refused just the same, and re-signing costs
about 150ms.

The certificates are opened and read before they are stored, so a pair that
cannot be used is refused while somebody is still looking, and the device it
names is taken from the certificate rather than believed. If the TV ever
rejects them at install, they are cleared automatically so the next attempt
starts clean rather than failing the same way forever. Nothing reads them back
out: a client can learn that certificates exist and which device they are for,
and nothing it could sign with.

`npm run certs -- <tv-ip> <pin> --forget` removes them.

## Security

The install endpoint is bound to every interface — that is the entire point —
so it is gated by a **6-digit pairing PIN** shown on the TV screen. The PIN is
regenerated every boot, never persisted, and `GET /pin` is served only to
loopback so a phone on the LAN cannot simply ask for it. No message other than
the handshake is processed before a client pairs.

## SDB command relay

Pinning Developer Mode to `127.0.0.1` locks every other machine out of the
TV's sdb daemon — that is the point, and it is also inconvenient when you want
a shell. Tizen Homebrew runs *on* the TV, so it is the one process still allowed to
reach loopback sdbd, and it can relay commands on your behalf:

```
phone ──WebSocket (PIN-gated)──▶ Tizen Homebrew ──▶ 127.0.0.1:26101
```

Full sdb shell access, developer IP never leaves loopback.

This is a real escalation over "install a signed package", so:

- **Off by default.** It must be turned on explicitly from the Shell tab, and
  staying on across reboots is a second, separate opt-in.
- **PIN attempts are limited.** Five failures locks pairing for five minutes.
  A 6-digit PIN is only 10^6 guesses, which is minutes for a script on the LAN
  once a shell is reachable.
- **Self-destructive commands are refused** — anything that would turn off
  developer mode, repoint the developer IP, or uninstall Tizen Homebrew itself. That
  is not a security boundary (the relay can trivially work around it); it stops
  you locking yourself out with no way back except a computer.
- **Output is bounded** at 1MB per command, with at most four running at once.
- **Every command is logged** to the service log.

Output streams back as it arrives, so long-running commands show progress
rather than appearing hung.

## The log

Debugging a service on a television is otherwise close to impossible: sdbd's
command allowlist excludes every log tool, and pulling files off the device is
refused. So the log comes *out* — and since it has to be read by a person
holding a remote, it is written the way Unix has written one since dmesg:

```
[    0.312] svc: startup finished in 312ms
[    0.906] sdb: loopback 127.0.0.1:26101 answered — this TV can install its own apps
[   38.004] auth: 192.168.2.31 paired
[   54.711] pkg: got tube.wgt: 2.41 MB in 1.61s (1.50 MB/s)
[   55.020] pkg: staged 2.41 MB to /home/owner/share/tmp/sdk_tools/package.wgt
[   59.220] pkg: installed Tube 0.1.0 in 7.22s
```

The timestamp is monotonic since the *service* started, which is the only
clock that means anything here — the service outlives its own reinstall and
long outlives the page displaying it. The facility says which part is talking:

| | |
| --- | --- |
| `svc` `net` | starting, listening, addresses, exiting |
| `http` `sock` | one line per request; phones connecting, talking, going away |
| `auth` | pairing, wrong PINs, lockouts |
| `dev` `sdb` | the television, and loopback sdb |
| `pkg` `cat` | packages fetched, verified, staged, installed; the catalogue |
| `relay` `cfg` | the command relay, and stored configuration |

Severity is a field rather than a word in the message, so the screen can colour
it and a reader can count the problems without reading them.

**On the TV**, `show logs` hands the whole screen to it: up and down move a
line, left and right a page, RED jumps back to the newest.

**Over the network**, `GET /logs?since=<seq>` returns the records as JSON —
loopback, or any client with the PIN. Each carries `{ seq, t, at, level,
facility, text }`, and the reply's `uptime` lets a client put its own events on
the service's clock, which is how the TV page interleaves what it knows with
what the service knows. The ring holds the last 1000 lines.

The one thing not recorded is the TV page's own polling of these endpoints:
that is the log being read rather than the system doing anything, and recording
it would mean every poll produced a line the next poll delivered. Set
`HOMEBREW_DEBUG=1` to keep those too.

## Updating it

Once the developer host IP is pinned to `127.0.0.1`, no other machine can reach
the TV's sdb daemon, so `bootstrap` no longer works — which is the point.
Updates are posted to Tizen Homebrew instead:

```sh
npm run push -- <tv-ip> <pin>
```

`POST /install` takes a `.wgt` body with the PIN in `x-homebrew-pin` and runs
it through the same pipeline as every other source. The background service
survives a reinstall, so a new Tizen Homebrew build needs a TV restart before the
running service is replaced.

---

## Releases

`.github/workflows/release.yaml` builds and signs the widget and attaches it to
the release that triggered it. Publishing a release or a prerelease is the
whole trigger; a full release additionally refuses a placeholder catalogue URL,
while a prerelease is allowed to carry one.

Set these once, in **Settings → Secrets and variables → Actions**:

| Kind | Name | What |
| --- | --- | --- |
| Secret | `TIZEN_AUTHOR_P12` | base64 of `author.p12` — `base64 -i author.p12 \| pbcopy` |
| Secret | `TIZEN_AUTHOR_PW` | its password |
| Secret | `TIZEN_DISTRIBUTOR_P12` | base64 of `distributor.p12` |
| Secret | `TIZEN_DISTRIBUTOR_PW` | **usually not needed** — only if the distributor password differs from the author's, which it does not when `create-samsung-cert` wrote the pair |
| Variable | `HOMEBREW_CATALOG_URL` | optional — overrides the catalogue origin baked in from `tizen.config.json` |

Tag and version have to agree: the workflow refuses a release tagged `v1.2.0`
whose `tizen.config.json` says something else, because it is the second number
that ends up inside the package. `npm run version -- 1.2.0` sets it everywhere.

The workflow can also be run by hand from the Actions tab, which builds a
widget and leaves it as an artifact rather than attaching it to anything.

### Certificates

Signing needs **two** certificates, and the second is not optional: a Samsung TV
rejects the stock Tizen distributor certificate at install time. A pair is
bound to one television, identified by its DUID:

```sh
npm run duid -- 192.168.2.9
```

That asks the TV over sdb, which is the value `create-samsung-cert` wants. It
only answers while the TV's developer host IP still points at this machine —
once that is pinned to `127.0.0.1`, the same question has to go through Tizen
Homebrew's own relay, from the phone UI's Shell tab. Failing both, the command
reads the device out of the distributor certificate you already have, which
carries it in its `subjectAltName`:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

Ignore the `duid` field the device API serves on port 8001. It is a different
identifier — `uuid:21f31367-…` on the same set that mints `CPCLIM2YRW7DO` — and
a certificate bound to the wrong one fails at install with `Check certificate
error` and no hint as to why.

Then mint the pair:

```sh
npx tizenjs create-samsung-cert --privilege Public \
  --name <you> --email <you@example.com> --password <password> \
  --duidList <TV-DUID> --output ~/.tizen-certs
```

That writes `author.p12` and `distributor.p12` side by side. Locally, point
`TIZEN_AUTHOR_P12` at the author one and `npm run package` finds the
distributor beside it:

```sh
export TIZEN_AUTHOR_P12=~/.tizen-certs/author.p12
export TIZEN_AUTHOR_PW=your-certificate-password
npm run package
```

---

## Layout

| Path | Role |
| --- | --- |
| `ui/tv.html` | The channel: URL, pairing code, readiness, remote deck |
| `ui/src/views/television.js` | Everything on the TV, including the log console and the credits |
| `ui/src/views/credits.js` | Whose work this is made of, one row per line |
| `ui/index.html` | The phone UI |
| `ui/src/app.css` | The whole design system, one file |
| `ui/src/scene/` | The sea: bubbles, and the channel theme |
| `ui/src/core/remote.js` | D-pad focus, so the TV page is usable by remote |
| `ui/dev/service.js` | A stand-in television, for `npm run dev` |
| `service/src/main.js` | HTTP + WebSocket server, install orchestration |
| `service/src/tv/device.js` | Dev-mode probe, platform version |
| `service/src/tv/sdb.js` | Promisified loopback SDB with real timeouts |
| `service/src/install/` | Manifest parsing, staging, `vd_appinstall` |
| `service/src/protocol.js` | Typed wire protocol with payload validation |

## The look

Both screens are the Homebrew Channel's, rebuilt: an ocean falling from a lit
surface to true black, god rays raking down through it, and bubbles rising
across the whole thing. Panels are Frutiger Aero glass over that water — a
gloss across the top half, a hairline of light along the top edge, and a
shadow that puts them in front of the sea rather than printed on it.

Nothing was eyeballed. Every colour was sampled out of the channel's own
artwork — `background_wide.png` for the sea, `button.png` and
`button_focus.png` for the two button states, `dialog_background.png` for the
panes — and `ui/src/scene/bubbles.js` is a port of `bubbles.c`, constant for
constant, including the detail that the number of bubbles follows the time of
day. The bubbles are drawn rather than blitted, because a television is 1920
wide and the original sprites are 64 pixels.

The one place the channel is not followed is the semantic colours. Its dialog
icons are green, red and indigo; on a screen that is otherwise entirely blue,
green and red read as status pasted over a picture. Ready, waiting and refused
are turquoise, amber and coral instead — see the note in `app.css`.

### The theme

The channel's banner music: an intro that plays once, then a loop, forever,
with nothing between them.

`tools/theme-audio.js` writes both parts into a single lossless file with the
loop point recorded, and `ui/src/scene/theme.js` plays that one buffer with
`loopStart` set. There is no handover to get wrong — the intro plays once
because the playhead starts before the loop point, the loop repeats because it
never passes the end again, and the join happens on the audio thread. Measured
in the browser, the step across the seam is smaller than the largest step
inside the music itself.

Regenerate it from an `hbc` checkout with:

```sh
node tools/theme-audio.js ../hbc
```

It is on by default on the television and off by default on the phone, which
is probably in the same room. Either way the choice is remembered.

The music, and the artwork every colour in `app.css` was sampled from, are the
Homebrew Channel's, by fail0verflow and contributors, released under the GNU
General Public License version 2 or later — compatible with this repository's
GPL-3.0. `hbc/` is not vendored here; `tools/theme-audio.js` reads a checkout
of it and the encoded result is what ships.

### The remote

Everything focusable on the TV page carries `data-focus`. `core/remote.js`
moves between them geometrically rather than in document order, restores focus
*by name* after a repaint — the views replace whole sections, so the element
that had focus is gone by the time the paint finishes — and adopts focus the
platform moves on its own, so a click and a D-pad press cannot end up
disagreeing about which control is current.

## Build

```sh
npm run build      # both pages, then the service bundle
npm run package    # the above, signed into release/tizenhomebrew.wgt
```

Two things the build does that are worth knowing about.

**The pages are checked against the television's engine.** Tizen 5.5 ships
Chromium 63 and Tizen 6.5 ships Chromium 76, and both fail at CSS *silently* —
an unknown at-rule takes the whole stylesheet with it and nothing is logged, so
a stylesheet that vanished this way is indistinguishable from one that never
loaded. The source is written in modern CSS, PostCSS lowers it, and then
`ui/build.js` reads its own output back and refuses to ship anything the TV
would drop. See `tools/css-support.js` for the list and why each entry is on
it.

**The service is bundled, then lowered, in that order.** Tizen 3's Node is
v4.4.3, so `service/build.js` rolls the service and its dependencies into one
file and lowers *that whole file* — dependency code included. Lowering only
first-party sources, which is the usual approach, leaves constructs in the
bundle that the platform cannot even parse.

## Develop off-TV

```sh
npm run dev          # both screens in a browser, live
npm run dev:service  # serves on :8091, reports state "notOnTv"
npm test             # protocol, PIN gate and precondition checks
```

`npm run dev` serves the television at `/tv.html` and the phone at
`/index.html`, with `/preview.html` showing every screen at once. With no TV
on the network it answers its own API calls and its own WebSocket from
`ui/dev/service.js` — the real protocol, a real socket and an install that
walks through its five phases on a timer — so the whole interface can be
worked on without hardware. Point it at a real device instead with:

```sh
HOMEBREW_TV=192.168.2.9 npm run dev
```

Then every API call and the socket are proxied to that TV, and the pages edit
live against it.

To exercise the packaged bundle instead of the sources:

```sh
HOMEBREW_ENTRY=dist npm test --workspace service
```

`HOMEBREW_CONFIG_DIR` relocates persisted state; `HOMEBREW_PORT` changes the
listen port.

## The catalogue

The list of apps lives in `catalog/` and is published to GitHub Pages by
`.github/workflows/pages.yaml`, which is where the default origin points:

```json
{
  "version": "0.1.0",
  "catalogUrl": "https://sushydev.github.io/tizen-homebrew/catalog.json"
}
```

That is deliberate. The URL is baked into the package at build time, so a
running TV never depends on an environment variable being set — and changing it
afterwards would otherwise mean reinstalling every television that has this on
it. Adding an *app*, though, is only a commit to `catalog/`: no rebuild, no
reinstall, and a TV picks it up the next time somebody opens the app list.

Pages has to be turned on once, in **Settings → Pages → Source: GitHub
Actions**. Until then the URL 404s, the channel says the origin was unreachable
and falls back to its cached list, which on a fresh install is empty.

`HOMEBREW_CATALOG_URL` overrides the origin for CI and one-off builds, and
`npm run package -- --release` refuses the example hosts in
`tools/config.js` outright — shipping one produces an app whose list is
permanently empty. A television already in the wild can be repointed without a
reinstall by setting `catalogUrl` in `/home/owner/share/homebrewConfig.json`,
which wins over the built-in origin; the log says which one is in use at
startup.

The catalogue must serve either a JSON array or `{ "apps": [...] }`, where each
entry is:

```json
{
  "id": "tizentube",
  "name": "TizenTube",
  "description": "Ad-free YouTube for Tizen",
  "version": "2.0.1",
  "source": { "type": "github", "ref": "owner/repo" }
}
```

`source.type` is `github` (newest release's `.wgt`/`.tpk`) or `url` (direct
https link). Entries that do not match this shape are dropped rather than
trusted. The catalog is cached on disk, so a TV with no uplink shows the last
known list instead of an empty screen.
