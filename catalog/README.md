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

