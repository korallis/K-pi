repo: korallis/K-pi
branch: main

## Last sync
date: 2026-09-03T20:46:47Z
### Updated in this project
- Read README (operator manual), docs/visual-targets.md, docs/agents-bus.md, docs/dune-architecture.md, the gated graph and both themes
- Copied the two board reference images into docs/visual/
- Wireframed a new global command center (turns 1 and 2) — original designs grounded in the run model, not a recreation of the current TUI

## Screen map
| Screen | Repo files |
|---|---|
| Fleet / home (1a–1d, 2a, 2e, 2h) | README.md §8–9, §12–14 · docs/agents-bus.md · packages/coding-agent/src/kpi/extensions/board.ts, command-centre.ts, bus/ |
| Job graph (1e–1g, 2c, 2f, 2g) | packages/coding-agent/src/kpi/graphs/coding-loop.gated.json · README.md §9, §13 · docs/visual-targets.md |
| Agent / session drill-down (1h–1j) | docs/agents-bus.md · README.md §14 · packages/coding-agent/src/kpi/extensions/bus/ |
| New job / gates (2b, 2d) | README.md §8, §19 · packages/coding-agent/src/kpi/schemas/task.schema.json, stack.schema.json · docs/dune-architecture.md |
| Colour language | packages/coding-agent/src/kpi/themes/loop-amber.json, protocol-blue.json (replaced by a fresh cool/warm pair per user request) |
