# Feature ownership and repository context

`stack.json` is the plan's explicit Product Feature Map input, not a prescribed language or folder layout. Existing Python, Go, Rust, layered and root-level projects remain valid. Vertical feature delivery is the default; horizontal delivery records a reason.

The operator's RP-22 **Preserve existing layouts** decision makes this the active ownership contract; see [RP-22](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild), PRD US-30 and `spec.md` §5 **SCH-stack**. It supersedes mandatory folder=id, auth-home, nested-only-layer, pre-created source/test twins and consumer-count gates, not explicit ownership or protected bounds. No offline document or fixture result alone accepts live canonical-context behavior.

## Ownership contract

A version-1 `shape: "dune"` stack declares `root`, `delivery`, modules and the current module identity. Each module declares `id`, `purpose`, `folder`, `interface`, `allowed_paths`, and `depends_on`. `root` and `folder` may be `.` for the project root. Identifiers need not equal folder names. The interface must be inside its declared folder and admitted by `allowed_paths`.

`allowed_paths` is the **only** ownership grant. Neither a folder label nor an inferred test twin widens it. Paths remain canonical repository-relative paths, checked both lexically and after symlink resolution. Traversal, absolute declarations, ownership without an explicit path prefix, missing dependencies and dependency cycles fail. Frozen module ownership must remain inside the protected task's declared write bounds. A worker claims only its selected feature's paths, never the union of every feature.

The selected `current_module_id` is explicit; `modules[0]` is never a default. Missing, stale or inconsistent stack/task selection blocks implement before writing and uses the execution-repair path (`spec.md` §6–§7); an ordinary map defect is not a mandatory product-approval gate. A stack is still unnecessary for the existing typo, unslop and comment-strip exemptions; the accepted playbook cannot be silently changed to gain one.

## Scaffold only what is needed

Optional `module.scaffold` lists exact directories the task actually needs. The scaffold operation creates only those authorized directories, preserving existing content. It never creates a TypeScript interface, empty test, test twin or placeholder behavior. `scaffold_first` is optional metadata, not permission to corrupt an existing layout. The implementer writes meaningful source and regression checks in the project's actual language and conventions.

Generic/layered folders and existing shared abstractions remain valid when their purpose, explicit paths and dependencies are declared. An interface path must be inside its declared folder and admitted; its declaration does not require fabricating that file. Tests use the project's actual locations and require explicit admitted paths. A `shared/` label grants no writes and a single consumer does not force relocation; unknown dependencies and cycles still fail. New abstractions must satisfy the accepted task and minimalist ladder, not an arbitrary consumer threshold.

```json
{"version":1,"shape":"dune","delivery":"vertical","root":".","current_module_id":"login","modules":[{"id":"login","purpose":"existing account login","folder":"app/services","interface":"app/services/login.py","allowed_paths":["app/services/login.py","tests/test_login.py"],"depends_on":[]}]}
```

## Canonical context after reset

`extensions/context/index.ts` exports `assembleAgentContext({projectRoot,runDirectory,agentId,role,taskId,modelContextWindow,outputReserve?})`, returning `{prompt,manifest}`. The engine awaits assembly immediately before inference and appends the returned context; the companion `createAgentContextExtension` registers native retrieval tools only, not a parallel loader or orchestrator. Errors propagate through engine preflight, not through optional extension hooks that could swallow them.

Assembly validates `task.json` against protected `intent.json`, retains the full protected task/goal/required acceptance/constraints and execution identity, then prioritizes ownership, repairs, goals/decisions, candidate/evidence, addressed peer messages, current source-backed knowledge and ranked repository entries. Missing intent is an explicit migration issue, never a permissive legacy fallback. Canonical artifacts are not rewritten or truncated. Per-agent manifests carry raw paths, content hashes and budget omissions; the prompt points to that manifest.

Compact JSON is the default. The input budget is model window minus output reserve. Accounting is explicitly a conservative UTF-8-byte token **estimate**, not tokenizer or provider usage. Mandatory overflow throws an actionable error naming the raw intent and requesting a larger window or lower reserve. Optional records are omitted whole, never silently clipped. The engine must reserve the existing system prompt, user prompt and transcript before passing the remaining window; native session compaction still owns transcript reduction. Live small-window inference remains separate acceptance evidence.

## Two distinct incremental projections

- `context/product-feature-map.json`: protected intent hash, declared feature purpose/ownership/dependencies, and observed owned file paths. It does not infer product acceptance from file existence.
- `context/repository-map.json`: version, revision, content hash, tooling hash, actual source file hashes/byte sizes/language extensions, and real language-server symbol results or explicit unsupported reasons. It does not grant ownership or pretend filename matching is semantic analysis.

Inventory uses tracked and nonignored Git files; a non-Git project uses a bounded-by-directory-policy filesystem walk that does not follow directory symlinks. Dependency/build/runtime-state directories and conventional credential paths are excluded. A full refresh detects additions, modifications and deletions; `context_map.affectedPaths` updates only the named files and preserves untouched entries. Unchanged content reuses its symbol result. Feature proximity and declared dependency proximity rank first, then query matches against actual symbol results and paths. Source bodies remain retrievable at their canonical paths.

`context_map` supports query, offset and limit for targeted navigation. `context_navigate` offers symbols, definitions and references with zero-based positions. No regex result is labeled semantic.

## Optional first-party LSP

Explicitly authorize installed local servers in project `.kpi/lsp.json`:

```json
[{"command":"pyright-langserver","args":["--stdio"],"extensions":[".py"],"languageId":"python"}]
```

This is executable configuration: review it before enabling it. The client reuses the harness process launcher, negotiates capabilities over native stdio JSON-RPC, opens current file text, performs read-only retrieval, and shuts down owned server processes. It never installs packages or accepts server-initiated edits. Missing binary, missing configuration, missing capability, malformed protocol, timeout and oversized source report unsupported with a reason. AST-backed symbols depend on the configured server; there is no fabricated regex/AST substitute when unavailable.

Research basis: [Aider repository map](https://aider.chat/docs/repomap.html) motivates budgeted symbol/dependency ranking; [Serena](https://github.com/oraios/serena) demonstrates real language-server symbol navigation; [TOON's limitations](https://github.com/toon-format/toon/blob/main/packages/toon/README.md#when-not-to-use-toon) favor compact JSON for irregular data unless measured token, accuracy and latency results justify a different encoding. These are design inputs, not runtime dependencies or live acceptance proof.
