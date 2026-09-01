# Dune architecture (folder-as-map)

**Normative for plan + implement.**

The point is simple: a stranger — human or agent — should understand the product by reading folder names. Auth lives under `auth/`. Billing lives under `billing/`. Feature one lives under that feature’s folder. Not in a shared `utils/` soup.

This matches Lauren Tan’s published pstack rules we already keep: foundational-thinking (scaffold before feature), model-the-domain, boundary-discipline, laziness-protocol. The extra constraint is **physical**: one capability, one folder.

## Folder map

Default layout for app code k-pi creates or extends:

```
src/
  auth/          # login, sessions, keys
  billing/       # invoices, plans
  <feature>/     # that feature only
  shared/        # truly shared types/interfaces only
test/
  auth/
  billing/
  <feature>/
```

Rules:

- Folder name is the capability name. No clever aliases.
- A feature’s UI, API, data, and tests sit next to each other under that name (`src/auth`, `test/auth`). Do not split one feature across `controllers/`, `services/`, `helpers/` as the primary map.
- Layer folders (`components/`, `hooks/`, `lib/`) are allowed *inside* a feature folder, not as the top map.
- `shared/` may hold types and adapters used by two or more features. If only one feature uses it, it moves into that feature.
- `utils/`, `helpers/`, `common/`, `misc/` as top-level homes are plan-gate failures unless the purpose field is specific and the folder contains fewer than five files.

## Vertical slices

Default delivery is a **vertical slice**, not a horizontal layer.

A slice is one user-visible capability cut through its own folder: interface → data → behaviour → tests. Auth login is one slice. “Write every API, then every screen” is not.

- Plan names slices. `modules[]` are slices.
- One implement round ships the one slice named by `task.json.current_module_id`. It does not ship “all controllers.”
- A slice may touch UI, API, and storage **inside its folder**.
- Shared code is extracted only after a second slice needs it.
- Horizontal work needs `delivery: "horizontal"` plus a reason, or a `no-stack` playbook.

`stack.json` field `delivery`: `"vertical"` (default) | `"horizontal"`.

## Scaffold first

Before feature logic, the implementer creates the empty map:

1. Feature folder
2. Public interface file (`index.ts` or `api.ts`)
3. Matching test folder
4. Then types
5. Then behaviour

An implement node that writes behaviour into an existing unrelated folder, instead of creating the feature folder, is `UNSAFE`.

## `stack.json`

```json
{
  "version": 1,
  "shape": "dune",
  "delivery": "vertical",
  "root": "src",
  "modules": [
    {
      "id": "auth",
      "purpose": "login and sessions",
      "folder": "src/auth",
      "interface": "src/auth/api.ts",
      "allowed_paths": ["src/auth/**", "test/auth/**"],
      "depends_on": []
    }
  ],
  "scaffold_first": true
}
```

`folder` is required. `allowed_paths` must be that folder plus its test twin. `claim_path` outside those globs is `UNSAFE`.

## Mandatory stack and current slice

The stack is a precondition, not a convenience. Implement reads a frozen contract; it never guesses one.

- Plan writes `stack.json`. The control plane freezes it before implement.
- Implement with no `stack.json`, or with a `stack.json` older than the current `task.json`, is `UNSAFE`. The node stops before its first write. There is no default shape and no on-the-fly regeneration.
- `task.json.current_module_id` is required for implement and must equal exactly one `stack.json.modules[].id`.
- Position is not identity. `modules[0]` is never the current slice — not as a default, not as a fallback after a failed lookup. A missing, empty, or unmatched `current_module_id` is `UNSAFE`.
- One implement round owns one `current_module_id`. Advancing to the next slice is a plan edit that re-freezes the contract, not an implementer decision.
- Implement bounds and `claim_path` read the module named by `current_module_id` — its `folder`, `interface`, and `allowed_paths` — never the union of every module.

`task.json` fragment:

```json
{
  "job_id": "2026-09-01-healthcheck",
  "current_module_id": "auth"
}
```

## Plan checklist

- [ ] every new capability has its own folder
- [ ] folder name matches `id`
- [ ] interface file lives inside that folder
- [ ] tests live in the twin folder
- [ ] no top-level `utils` / `helpers` / `common` / `misc` without a tight purpose
- [ ] scaffold folders exist before behaviour
- [ ] research.md names the stack versions
- [ ] `delivery` is `vertical` unless a reason is recorded
- [ ] the next implement round is one slice, not one layer
- [ ] the current slice is named in `task.json.current_module_id`, never inferred from `modules[0]`

Exempt playbooks: `no-stack` (typo, unslop, comment-strip).
