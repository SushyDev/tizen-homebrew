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
`tizen-manifest.xml`. It is optional, and it is the only thing that lets a row
say **update** rather than **install**: the television matches it against its
own list of installed packages, and where it finds one it asks GitHub what the
app has released since.

The versions are compared as semver, so `0.10.0` is newer than `0.9.9` and
`1.2.0-rc1` is older than `1.2.0`. The button lights up only when the release
is strictly newer than what is on the set — a television running a hand-pushed
build ahead of the release is never offered a way backwards.

That comparison is against the release, not against `version` here, for
`github` apps: a number written into this file is one somebody has to keep
true by hand, and the release is the thing that actually moves. `version` is
what stands for a `url` app, and what stands when GitHub cannot be reached.

Tizen Homebrew is in this list for that reason. It is how the channel reaches
its own next version — the app list on your phone is also the update button
for the thing drawing it.

An entry with no `packageId` is never anything but **install**, which is what
every entry was before this existed. Installing over a version already on the
set is fine; Tizen treats it as an upgrade, provided the author certificate
has not changed — and it has not, because the television re-signs everything
it installs with its own pair.

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

