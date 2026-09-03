repo: korallis/K-pi
branch: main
path: packages/coding-agent/src/kpi

## Last sync
date: 2026-09-03T11:47:07Z

### Updated in this project
- Recreated the compact always-on board widget (paintCompact @160 cols) with editor and K-π footer
- Copied the two board reference images and the OMP footer reference from docs/visual
- Proposed tabbed widget variants (BOARD / GRAPH / EVENTS), paused board, terminal states

## Screen map
| Screen | Repo files |
|---|---|
| 1a current widget | packages/coding-agent/src/kpi/extensions/board.ts, board-frame.ts, board-component.ts, status-line/segments.ts, status-line/brand.ts, status-line/index.ts, renderers.ts, themes/loop-amber.json |
| 1b BOARD tab | board.ts, status-line/segments.ts, graph/budget.ts (limits), themes/loop-amber.json |
| 1c GRAPH tab | graphs/coding-loop.gated.json, board.ts, themes/loop-amber.json |
| 1d EVENTS tab | renderers.ts, accounts/widget.ts, board.ts (researchCellFromDocument), themes/loop-amber.json |
| 1e paused board | board.ts (Board B regions), themes/protocol-blue.json, docs/visual/kpi-board-protocol-pause.jpg |
| 1f terminal states | board.ts (stopTone / STOP vocabulary), README.md §9, §20 |
