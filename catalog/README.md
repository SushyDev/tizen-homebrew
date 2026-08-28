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
  "source": { "type": "github", "ref": "owner/repo" }
}
```

`source.type` is `github` — the newest release's first `.wgt` or `.tpk` asset —
or `url`, a direct https link. Entries that do not match that shape are dropped
rather than trusted, so a malformed one costs its own row and nothing else.

One asset per release, for the `github` kind: the resolver takes the first
package it finds, so a release carrying two of them installs whichever GitHub
happens to list first.
