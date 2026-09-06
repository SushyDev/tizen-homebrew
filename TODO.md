[x] fix reloading/reset of entering pin
[x] back button / exit should stop the process / exit the entire program (right now it keeps running, music even runs on the tizen homescreen)
[x] restart process button
[x] make package sign opt in instead of opt out
[x] rename references of tizenhomebrew.wgt to homebrew.wgt
[ ] rewrite `tizen` dependency for better reliability and to unlock more capabilities
[ ] list packages by enumerating `/opt/usr/apps` instead of `tizen.package.getPackagesInfo`, which blocks the service for ~5 minutes on tizen 9
[ ] build a partner privilege test matrix: one disposable widget per candidate privilege, recording install acceptance, api exposure, call result and reboot persistence, and only promote a privilege into the homebrew manifest after it passes
[ ] check whether productinfo, network.public, sso.partner, mde and edge privileges are accepted for a partner signed third party widget
[ ] probe the `wrt.tv` and `wrt.mde` bindings one at a time in a disposable test package to find which are permission gated
[ ] inventory `webapis.*` from a running widget page, since the node service scope never gets it injected
[ ] test whether sdb `vd_appuninstall` removes developer installed widgets, using a disposable test widget and never a samsung package
[ ] document that package removal needs `packagemanager.install` and a platform certificate, which the samsung account endpoint cannot issue
[ ] system dashboard: memory, uptime, platform, model, firmware, network state, free space, sdb availability and certificate coverage
[ ] app library: package inventory with versions, user app filtering, manifest and privilege inspection, launching through app control
[ ] media and storage tools: browse `/home/owner/content` and `/media`, extract archives in the app workspace, checksums, downloads through `tizen.download`
[ ] diagnostics report: declared privileges, listening sockets, service logs and a public/partner compatibility check
[ ] keep `/home/owner/share`, accounts, sso, remote input injection and web history out of feature work
