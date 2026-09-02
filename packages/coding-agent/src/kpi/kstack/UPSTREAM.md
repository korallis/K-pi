# K-stack upstream

| Source | https://github.com/cursor/plugins.git |
|---|---|
| Path | pstack/ |
| Commit | efa2a531985e0a8084d36ff3cf87233be8a9f34b |
| pstack tree | 1c625329e71538629f087374daa71293a498089f |
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

Pinned-deps (`scripts/check-pinned-deps.mjs`) excludes the vendored `upstream/` path only — a byte-for-byte mirror that keeps loose specs (e.g. `skills/poteto-mode/scripts/package.json` with `bun-types`/`typescript: "latest"`); `generated/` ships no `package.json`, and the overlay drops or pins any such manifests before emit.
