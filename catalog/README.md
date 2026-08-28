# The catalogue

`catalog.json` is the list of apps the channel offers, published to GitHub
Pages at:

    https://sushydev.github.io/tizen-homebrew/catalog.json

That URL is the default in `tizen.config.json`, so it is baked into every
build. Adding an app is a commit to this directory — no rebuild, no reinstall,
and the TV picks it up the next time somebody opens the app list.

Each entry:

```json
{
  "id": "tube",
  "name": "YouTube",
  "description": "YouTube without the advertisements",
  "version": "0.1.0",
  "packageId": "tUb3Xq7Lm9",
  "icon": "https://example.com/tube.png",
  "source": { "type": "github", "ref": "owner/repo" }
}
```

`source.type` is `github` — the newest release's first `.wgt` or `.tpk` asset —
or `url`, a direct https link. Entries that do not match that shape are dropped
rather than trusted, so a malformed one costs its own row and nothing else.

One asset per release, for the `github` kind: the resolver takes the first
package it finds, so a release carrying two of them installs whichever GitHub
happens to list first.

## Updates

`packageId` is the id the app installs under — the `package` attribute of
`<tizen:application>` in its `config.xml`, or `package` in a
`tizen-manifest.xml`. It is optional, and it is what lets a row know the app is
already on the television.

That half is free: the platform answers "what is installed" for every app at
once, locally, so the app list draws with it and never waits. Every installed
row shows its version straight away.

What an app has *released* is the other half, and it is one GitHub request per
app. A catalogue with two hundred entries in it cannot spend two hundred
requests on the way to drawing a screen — GitHub allows sixty an hour to a
television nobody has signed in from — so nothing asks until somebody presses
**check** on a row, or **check all** under the list. Lookups run three at a
time, are remembered for six hours, and stop early if GitHub starts refusing.

Then:

| The row says | Because |
| --- | --- |
| **install** | The app is not on this TV |
| **update**, lit | It is, and the release is newer |
| **update**, blocked · *up to date* | It is, and the release is not newer |
| **update**, blocked · nothing after the version | Nobody has checked yet |
| **update**, blocked · *no release found* | Checked, and the repository has none |

Versions compare as semver, so `0.10.0` is newer than `0.9.9` and `1.2.0-rc1`
is older than `1.2.0`. Only strictly newer lights the button — a television
running a hand-pushed build ahead of the release is never offered a way
backwards.

For a `github` app the comparison is against the release, not against `version`
here: a number written into this file is one somebody has to keep true by hand,
and the release is the thing that actually moves. `version` is what stands for
a `url` app, which has no releases page to ask and so is answered the moment
the list arrives.

Tizen Homebrew is in this list for that reason. It is how the channel reaches
its own next version — the app list on your phone is also the update button for
the thing drawing it.

An entry with no `packageId` is never anything but **install**, which is what
every entry was before this existed. Installing over a version already on the
set is fine; Tizen treats it as an upgrade, provided the author certificate has
not changed — and it has not, because the television re-signs everything it
installs with its own pair.

## Logos

`icon` is optional and almost never needed. Leave it out and a `github` app is
assumed to keep its logo at:

    https://raw.githubusercontent.com/<owner>/<repo>/HEAD/logo.png

`HEAD` is the repository's default branch, whatever it is called, so nothing
here goes stale when one is renamed. Adding a logo to an app is therefore a
commit to *that* repository, not to this one.

Set `icon` only where that is wrong — a logo kept somewhere else, or a `url`
app with no repository to look in. It must be `https`, for the same reason a
package URL must be.

An app with no logo at all is fine and is the ordinary case: the phone draws a
tile with the app's first letter in it. Nothing is retried, nothing is logged,
and a 404 here can never stop an app installing.

