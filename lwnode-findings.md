# What lwnode says about the television

Notes from reading `Samsung/lwnode` at `b3de7be5` (main, node 14.14.0) and its
`origin/release` branch (v1.1.26, the one Tizen actually ships), against this
service as it stands.

Every claim below is either **verified** (a file and line in lwnode you can go
read), **inferred** (follows from verified code but the conclusion is mine), or
**needs a set** (a one-line probe would settle it and nothing here has one).
They are marked, because the expensive mistakes in this repo have all been
confident sentences with no evidence behind them.

---

## 0 · First, the question this all hangs on

`tools/matrix.js` records Node **12.16.3** on a 6.5 set and **18.18.2** on a 9.0
set, and calls both mainline. lwnode's `main` is forked from node **14.14.0**
(`deps/node/src/node_version.h`), and `origin/release` — version 1.1.26, dated
2026 — is *still* 14.14.0. Neither of the two versions you measured is a
version lwnode has ever claimed.

So on the evidence in this repo, the sets you have tested are running mainline
Node under `wrt-service`, and lwnode is not in the path at all. The comment in
`matrix.js` guesses lwnode below Tizen 6.0; that guess is consistent with
everything I read and is not confirmed by anything.

That does not make the audit worthless, for two reasons.

1. Half of what lwnode reveals is not about lwnode. It is Samsung's *platform*
   — where device APIs live, what `console.log` does on a Tizen app, how the
   event loop is married to GLib — and that is the same whichever engine is
   underneath. Section 1.
2. `runtime.js` exists precisely because a set might report Escargot one day.
   Section 2 is what to do on the day it does, and one item in it is cheap
   enough to be worth doing before then.

**The probe that settles it permanently.** One line into the startup log, from
a real set, and `matrix.js` never has to guess again:

```js
process.versions.escargot          // present ⇒ lwnode, and its version
typeof process.lwnode              // 'object' ⇒ lwnode, even if versions lied
require('fs').existsSync('/usr/bin/lwnode')   // the binary is on the set at all
```

`runtime.js` already reads the first. The second and third cost nothing and
distinguish "this set has lwnode installed" from "this service is running on
it" — which are different questions and are currently conflated.

---

## 1 · True regardless of which engine runs the service

### 1.1 The device-API inventory is a directory listing

lwnode's device-api module loads each Tizen namespace by `dlopen`ing a shared
object out of one directory
(`modules/packages/device-api/src/TizenDeviceAPILoaderForEscargot.cpp:108-118`):

```
/usr/lib/tizen-extensions-crosswalk/libtizen_<name>.so   →  tizen.<name>
/usr/lib/tizen-extensions-crosswalk/libwebapis_<name>.so →  webapis.<name>
/usr/lib/tizen-extensions-crosswalk/libtizen.so          →  tizen (the root)
```

with three names spelled irregularly and hardcoded: `sensorservice` →
`libtizen_sensor.so`, `sa` → `libwebapis_sa.so`, `tvaudiocontrol` →
`libtizen_tvaudio.so`.

This is the WRT plugin model, not an lwnode invention, so **the same directory
answers the same question on a set running mainline Node**. One `readdir` tells
you exactly which `tizen.*` and `webapis.*` namespaces *this particular
television* has — model by model, firmware by firmware — instead of calling one
and finding out from a `TypeError`.

*Verified in lwnode; needs a set to confirm the directory exists on retail
firmware.* Worth putting in `doctor` and in the startup log: it is a single
cheap read that would have named, in advance, every capability question this
project has answered by experiment.

### 1.2 What Samsung considers service-safe

`TizenDeviceAPILoaderForEscargot.h:52-64` is the list of namespaces lwnode
binds into a **non-UI** context. It is a short list and it is interesting for
what is on it:

```
application  bluetooth  filesystem  mediacontroller  messageport
systeminfo   sensorservice  tvaudiocontrol  preference  power  time
tvinputdevice
```

plus the `ApplicationControl` / `ApplicationControlData` constructors
(`:66-68`). `package` is **not** on it — which matches, from the other
direction, `tv/packages.js` finding `tizen.package.getPackagesInfo` unusable.

Three of these are worth an experiment each:

- **`tizen.application.getAppsInfo()`** is a different subsystem from
  `tizen.package` (AUL/amd rather than pkgmgr) and returns, per app, `id`,
  `name`, `version`, `iconPath`, `packageId` — which is most of what
  `tv/packages.js` currently reconstructs by reading `/opt/usr/apps`, three
  hundred directory reads and up to six hundred `config.xml` parses. It is
  callback-based, so it cannot block the way the *synchronous-in-effect*
  `getPackagesInfo` did, and it needs no privilege beyond what is already
  declared. **Needs a set**, behind the same kind of deadline
  `tv/packages.js` already documents, with the disk scan as the fallback. If it
  works you also get icons for installed apps for free.
- **`tizen.messageport`** is a TV-page ↔ service channel that needs no port, no
  PIN and no loopback HTTP. It would not replace the phone's HTTP API, but the
  television's own page currently polls `127.0.0.1:8091` once a second for its
  log; a message port is the mechanism that exists for exactly that.
- **`tizen.power`** — `request('SCREEN', 'SCREEN_NORMAL')` holds the panel
  awake. A three-minute `vd_appinstall` on a set that dims at ninety seconds is
  a support question waiting to happen.

`tizen.preference` is also there, which is a platform-backed key/value store,
if `config.js` ever outgrows a file.

### 1.3 `console.log` on a Tizen app goes to dlog, under the app id

This one is fully traced:

- `deps/node/lib/internal/bootstrap/switches/is_main_thread.js:45-60` — on
  Tizen, `process.stdout` and `process.stderr` are *not* real streams. They are
  plain `Writable`s whose `write` calls `process.lwnode._print`.
- `process.lwnode._print` → `binding.logger`
  (`deps/node/lib/internal/lwnode/setup.js:35-37`) →
  `deps/node/src/node_process_methods.cc:434` → `FPrintF(stderr, …)` →
  `debug_utils.cc:474-479`, where `FWrite` is patched to call
  `LWNODE_USER_LOG(str)` instead of `fwrite`.
- `LWNODE_USER_LOG` → `DlogOut::flush` →
  `dlog_print(DLOG_INFO, tag, …)` (`src/api/utils/logger/logger.cc:29`).
- and the tag is set to the **app id** when the process was launched by AUL:
  `LogKind::user()->tag = appid_` in
  `deps/node/src/lwnode/aul-event-receiver.cc:134-137`, with the app id read
  from `aul_app_get_appid_bypid(getpid(), …)`.

From lwnode 1.1.25 each line is additionally prefixed with the engine version
in parentheses — `(1.1.25) your message` — because `DlogOut::flush` was changed
to print it (commit `f7a2e880`). That prefix is a free version fingerprint if
you can ever read the log.

Two consequences. First, on an lwnode set **stdout does not exist**: nothing
you print reaches a pipe, a file, or `sdb shell`, only dlog. `obs/log.js`
recording in-process is not belt-and-suspenders there, it is the only copy.
Second, `dlogutil GJBBYNLkgP.TizenHomebrewService` is the system-level view of
this service — worth knowing exists, even though the README is right that
sdbd's allowlist will not run it for you.

*Verified for lwnode. On a mainline-Node `wrt-service`, whether stdout is piped
to dlog is a platform choice I could not verify — needs a set.*

### 1.4 Why a platform call can wedge the whole service

`deps/node-bindings/src/gmainloop_node_bindings.cc` shows how a Tizen app
runs Node: the **uv loop is a `GSource` inside a `GMainContext`**. Its dispatch
callback does `g_main_context_iteration(gcontext, FALSE)` and *then*
`node_bindings->RunOnce()` — one thread, GLib and uv taking turns.

That is the mechanism behind the note at `service/src/main.js:97-118`. A
device-API call that blocks inside GLib does not merely delay the JS thread; it
stops the source dispatching, so uv never runs, so timers do not fire — which
is exactly the tell you identified ("a timer that does not fire is a blocked JS
thread, not a slow platform call"). The architecture agrees with the diagnosis.
Same reasoning says: any device API called on a hot path deserves the deadline
treatment, and the deadline has to be enforced by something other than a timer.

### 1.5 Small true things

- `/usr/bin/lwnode` and `/usr/bin/lwnode.dat` are what the RPM installs
  (`packaging/lwnode.spec`, `%files`). `.dat` is the archive of node's builtin
  JS, loaded from next to the executable
  (`deps/node/src/node_native_module_lwnode-inl.h:205`). Presence of the pair
  is a cheap "this set has lwnode."
- The service-app shape Samsung documents is `module.exports` an Express app
  and `app.listen()` (`modules/apps/template/lib/index.js`). Nothing in lwnode
  implements `onStart`/`onStop` — that lifecycle is `wrt-service`'s, above the
  engine. So `service/build.js`'s check for `onStart` in the bundle is
  guarding the right thing at the right layer.

---

## 2 · What changes if a set ever reports Escargot

### 2.1 No regex lookbehind, no named capture groups — and this is the one to act on now

lwnode does not document this. It patches around it, four times, in node's own
library, each time by commenting out the original:

| where | what was removed |
| --- | --- |
| `deps/node/lib/internal/util/inspect.js:186-188` | `(?<![/\\])` — lookbehind |
| `deps/node/lib/internal/util/inspect.js:1408-1410` | `split(/(?<=\n)/)` → `split(/^/m)` |
| `deps/node/lib/repl.js:633-635` | the same `(?<=\n)` split |
| `deps/node/lib/internal/source_map/source_map_cache.js:61-68` | `(?<sourceMappingURL>…)` named group, and `match.groups` with it |

An unsupported regex is a **`SyntaxError` where the literal is parsed**, not a
wrong match at runtime. For a single minified bundle that means the service
does not start, the port never opens, and nothing writes a log to say why —
which is, precisely, the failure mode `check-syntax.js` and `matrix.js` were
each written after suffering.

**Today both bundles are clean** — I checked `service/dist/index.js` and
`ui/dist`: zero occurrences of `(?<=`, `(?<!` or `(?<name>`. Nothing keeps them
that way. `node-forge`, `jszip`, `ws`, `xmldom`, `xml-crypto` and the `tizen`
signer are all free to introduce one in a patch release.

This is also **not only an Escargot problem**. Named capture groups landed in
Chromium **64**; the phone and television pages are held to **63**. So the
webview has the same floor, and `tools/css-support.js` guards the stylesheet
against exactly this class of silent death while nothing guards the script.

Recommendation: extend `service/check-syntax.js` — it already walks the AST, so
a `Literal` node with a `.regex` property is two lines — and add the mirror
check for the UI bundles next to `css-support.js`. Cost: an afternoon. It
closes the same door twice.

### 2.2 `require('v8')` throws

`deps/node/lib/internal/bootstrap/loaders.js:105-108` blacklists `v8` from user
requires outright; `:177-179` makes `canBeRequiredByUsers` false for it. Not a
stub returning empty — `MODULE_NOT_FOUND`. Nothing in the bundle requires it
today (checked), but it is the module a dependency reaches for to serialize
structured data.

### 2.3 The rest of the missing surface

From `docs/Spec.md` and the build flags in `configure.py:100-104`
(`--with-intl=none --without-inspector --without-node-snapshot`):

- **No `Intl`.** Built with ICU disabled. `Intl.NumberFormat`,
  `Intl.DateTimeFormat`, and locale-aware `toLocaleString` degrade or throw.
  The service uses none of them (checked) — `obs/units.js` formats by hand,
  which turns out to be the portable choice.
- No `vm`, no `repl`, no `inspector`, no `perf_hooks`, no `trace_events`, no
  WASI (`isEnabledFeature('WASI')` returns false,
  `internal/lwnode/setup.js:23-24`).
- `worker_threads` is experimental and `SharedArrayBuffer`/`Atomics` are
  avoided internally (`deps/node/lib/internal/worker.js:82-91` replaces a
  `SharedArrayBuffer` with a plain `ArrayBuffer` and an `Atomics.add` with an
  assignment).
- Node-API (`.node`) addons *are* supported and `process.dlopen` exists
  (`node_process_methods.cc:469`). Shipping an armv7l addon inside the `.wgt`
  is therefore mechanically possible. I would not: it buys nothing the sdb
  route does not already give you, it would have to be built per ABI, and the
  Smack label the app runs under is what actually gates the privileged calls
  you would want it for.

### 2.4 Every outgoing HTTP request gets a 15-second timeout whether you asked or not

On `origin/release` only (commit `295a0d73`, `deps/node/lib/_http_client.js:777-788`):

```js
if (req.timeout !== undefined || (req.agent && req.agent.options && req.agent.options.timeout)) {
  listenSocketTimeout(req);
} else {
  // @lwnode: Set default 15 second timeout
  socket.setTimeout(15000, () => { if (!req._hasUserTimeout) req.destroy(); });
}
```

A request that sets no timeout is destroyed after 15s of socket inactivity, and
because it is `destroy()` rather than an emitted `'timeout'`, it surfaces as
`ECONNRESET` / "socket hang up" — an error that names the network rather than
the deadline.

`remote/fetch.js` already calls `outgoing.setTimeout(…)` on every request, which
sets `_hasUserTimeout` and suppresses the destroy, and the ordering works out
(the default is installed at `tickOnSocket`, the user's value applied on the
`'socket'` event that follows, so a value *larger* than 15s is not clamped).
So this is currently harmless — but it is harmless by a coincidence of two
lines in different files, and the next place that calls `https.get` directly
inherits a 15-second ceiling with a misleading error. Worth a line in
`fetch.js`'s header comment and a test that asserts the timeout is set.

### 2.5 `process.stdout` is not a stream

Per §1.3 it is a bare `Writable` with `fd` and `_isStdio` bolted on. No
`isTTY`, no `columns`, no `_type`, no `write` backpressure that means anything.
Anything that feature-detects a TTY to decide on color or width sees a
non-TTY. `tools/ui.js` runs on the laptop so it does not care; a future
in-service formatter would.

### 2.6 What Samsung's own test run refuses to make claims about

`deps/node/test/skip_tests.txt` (217 entries) and `skip_features.txt` are the
honest list of what lwnode does not promise. The entries that touch this
service:

- **`test-string-decoder.js`, `-end`, `-fuzz`** — all three. `StringDecoder` is
  not trusted upstream. `tv/sdb.js` does `chunk.toString()` per chunk, which is
  the same hazard by hand: a multi-byte character split across two TCP reads
  is corrupted. sdb output is ASCII in practice, so this is a latent issue
  rather than a live one.
- **`test-buffer-alloc.js`**, and `test-buffer-constants` / `test-net-bytes-written-large`
  skipped explicitly for **out of memory**. Large buffers over sockets are the
  documented weak spot, and the install path holds the archive, the unzipped
  entries, the re-signed zip and the response body at once.
- **`test-process-env.js`**, `-symbols`, `-tz` — `process.env` semantics
  differ; `Spec.md` states outright that a child process may not receive it.
- `test-fs-write.js` is skipped for "one assert: utf8/latin1 encoding
  mismatch"; `test-util-format.js` and `test-util-inspect.js` for formatting
  differences. Do not assert on the *text* of anything `util.inspect` produced.

### 2.7 An extra module search path

`deps/node/lib/internal/modules/cjs/loader.js:606-609` appends
`/usr/apps/lwnode/node_modules` to the resolution paths when
`hasSystemInfo('tizen')`. Free modules if the set has any (Samsung ships
`express` and `sqlite3` there for the DB-service framework, per
`docs/App-db-service.md`). Also a directory outside this app that can satisfy
a bare `require` — worth knowing about even though the bundle has no bare
requires left.

### 2.8 `process.lwnode` — the whole object

`deps/node/lib/internal/lwnode/setup.js`, plus `src/lwnode/lwnode.cc:215-237`:

| member | what it is |
| --- | --- |
| `hasSystemInfo(name)` | `'tizen'` on a Tizen build; **`'appid'` once AUL has named the process** (`aul-event-receiver.cc:97`) — i.e. "launched as an app" vs "run from a shell" |
| `PssUsage()` `PssSwapUsage()` `RssUsage()` | live process memory in bytes, parsed from `/proc/self/smaps`, cached 600ms (`lwnode.cc:69-80`) |
| `MemWatcher` | `EventEmitter` with `stats` / `max` / `limit` events; `new MemWatcher({ limit })` fires `limit` when PSS crosses a threshold (`docs/lwnode.md`) |
| `MemDiff` | heap deltas between two points |
| `MemSnapshot()` | writes `/tmp/smaps-<app>-<time>.csv`; returns `false` in `PRODUCTION` builds |
| `isEnabledFeature(name)` | only `'WASI'` is ever false |
| `isReloadScriptEnabled()` | whether module source is dropped and re-read on demand rather than held |
| `_print` | the dlog path from §1.3 |

and on `origin/release` only: `postMessage(string)`, `onmessage`,
`sendMessageSync(string)`, `ref()`, `unref()`, `getModuleList()`. Those are a
channel to whatever *embeds* lwnode. Whether `wrt-service` wires anything to
the other end is unknown and would be one `typeof` to find out.

`MemWatcher` and `PssUsage` are the two worth having. The install pipeline is
the memory-hungriest thing this service does, on the most memory-constrained
machine it runs on, and right now nothing observes that.

### 2.9 How the garbage collector behaves, and what follows

Boehm GC, tuned small: `Memory::setGCFrequency(24)` (`src/api/engine.cc:352,368`)
means collect when free space falls below a twenty-fourth of the heap — the
memory-over-CPU trade the whole project is named for. `mallopt(M_MMAP_THRESHOLD,
2048)` sends anything over 2KB straight to `mmap`, so large `Buffer`s are
returned to the OS promptly rather than fragmenting the heap.

Collection is scheduled from a `uv_prepare` handle — i.e. **once per event-loop
turn** (`deps/node/src/node_platform.cc:223-227` and `:240`, installed only in
external-builtins builds, which is what the Tizen RPM produces). The default
strategy is `DelayedGC` (`src/lwnode/lwnode-gc-strategy.cc:43-70`): a full GC
1500ms after the loop last turned, and at most every 5000ms while it keeps
turning. A GC is `enterIdleMode()` + `Escargot::Memory::gc()` + `malloc_trim(0)`
(`lwnode.cc:239-246`).

The operational consequence: **a long synchronous stretch of JS collects
nothing.** Peak memory during an install is set by how long the pipeline goes
without yielding. `install/resign.js` is already `await`-heavy because JSZip is
async, which is the right shape by accident; it is worth keeping on purpose,
and worth knowing that an `await` there is not only politeness to the
television's own page — it is the only moment the collector gets.

---

## 3 · Worth doing, in the order I would do them

**Status: all five landed, plus `background-support` and a developer REPL.**

Since verified on a QE65S93DAT running Tizen 9.0, which corrects two things
written above.

**§0 is settled.** That set runs mainline **Node 18.18.2 on V8 12.0.267.1**,
`process.platform === 'tizen'`, arm, abi 108, full ICU 74.1 — and
`/usr/bin/lwnode` is not on it at all. lwnode is not in this path. Everything in
§2 remains contingency for sets that report Escargot, and §1 holds regardless.

**§2.8 is wrong about memory, and so was item 3 below.** Smack denies the
service its own `/proc`: `process.memoryUsage()` throws `EACCES`, and
`/proc/self/statm`, `/proc/self/status` and `/proc/self/smaps` are all refused —
which takes lwnode's `PssUsage`, `RssUsage` and `MemWatcher` with them, since
they parse smaps. `/proc/meminfo` is readable and describes the television.
What does work there is `v8.getHeapStatistics()`, including `external_memory`
where Buffers live, and `process.resourceUsage().maxRSS`. `obs/memory.js` now
asks for all of them and reports whichever answer.

1. **Reject lookbehind and named capture groups in the build.** §2.1. Extends
   `service/check-syntax.js` by a few lines and wants a mirror for the UI
   bundle next to `tools/css-support.js`. It is the only item here that
   prevents a failure with no log — which is the failure this repo keeps
   paying for.

2. **An engine and platform capability line in the startup log.** Fits the
   branch you are on. `runtime.js` already names the engine; add, once, at
   start: `process.lwnode` present and which of its methods exist,
   `/usr/bin/lwnode` present, `typeof Intl`, and the `readdir` of
   `/usr/lib/tizen-extensions-crosswalk` from §1.1 — which is the single most
   informative read on the whole set. That one line closes the open question
   in `matrix.js` the first time somebody's television reports in.

3. **Memory, during an install.** §2.8. `process.lwnode.PssUsage()` where it
   exists, `process.memoryUsage().rss` where it does not, sampled at the six
   named steps in `install/pipeline.js`. The set is memory-constrained, the
   pipeline is the peak, and nothing currently records it — so an install that
   dies on a 4GB television is presently indistinguishable from one that was
   refused.

4. **Try `tizen.application.getAppsInfo()` behind a deadline.** §1.2. If it
   answers, the installed list stops costing nine hundred filesystem
   operations and starts carrying icons. If it wedges, it wedges the way
   `getPackagesInfo` did and you keep the disk scan — so this is an experiment
   with a known-good fallback already written.

5. **Write the 15-second HTTP default down.** §2.4. It is currently handled by
   accident. A sentence in `remote/fetch.js` and an assertion in the test suite
   makes it handled on purpose.

---

## Appendix · Two things I found that are not lwnode

**The music on the home screen.** `config.xml` sets
`<tizen:setting background-support="enable" …>`. That is the setting that tells
the WRT not to suspend the page when it loses the foreground, and it is the
most likely reason `application.exit()` at `ui/src/tv.js:177` leaves the page —
and its `AudioContext` — alive behind the Tizen home screen. The service is a
separate application and is unaffected by it either way, so turning it off
costs nothing you are using. **Needs a set**: set it to `disable`, rebuild,
press back, listen.

**Stopping the service is already possible.** `tv/packages.js` launches an app
by id, and the comment there notes the service already exits to reload its own
code. So "restart process" is `process.exit(0)` in the service plus the
existing `launch()` from the page — no new mechanism required, only a route.
