# K-stack upstream

| Source | https://github.com/cursor/plugins.git |
|---|---|
| Path | pstack/ |
| Commit | b9ddc83c32972210b8a94d389130713e8eed346e |
| pstack tree | 950b90234c17babd00c43e32b19ae50abb4720f5 |
| Upstream version | main snapshot 2026-08-31 |
| K-stack overlay | 1 |

`provenance.json` beside this file is the machine-readable record: the same origin, commit and
`pstack/` tree id, plus the transform version, the ordered patch digests, and the licence
provenance. Both files move together, and only `npm run kstack:sync -- --pin <sha>` moves them.

Drift is a tree, not a HEAD. `npm run kstack:sync:check` is offline: it rebuilds from the
vendored `upstream/` subtree and fails on byte drift, on a semantic diagnostic, or on a pin
whose recorded tree id no longer matches those bytes. `npm run kstack:status` reports whether
upstream has moved and never changes the pin.

Generated content is produced by `npm run kstack:sync`; runtime package loading never fetches
the network.
