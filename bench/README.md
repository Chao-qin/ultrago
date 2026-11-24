# bench/

Committed input data for the snapshot-size guard — not a scratch directory. CI reads it on every run.

| Path | What it is | Written by |
|---|---|---|
| `snapshots/<page>.json` | Raw `SnapshotElement[]` of a public page, captured by the real `bcpDomRuntime` at 1280×800, scrolled to the top. One element per line. | `pnpm --filter @bcp/extension snapshot:capture [page…]` |
| `snapshot-census.json` | Baseline per page: default-reply tokens, pages to read it all, elements listed. | `node scripts/snapshot-census.mjs --write` |

`pnpm check:snapshot` (CI step "Snapshot census") renders the snapshots with the backend's real renderer and fails when a default reply moves more than 5% either way, takes a different number of pages, or lists a different number of elements than the baseline, and when a reply's printed refs or its hidden accounting disagree with what the renderer reports. When a change to the reply is intended, re-run `--write` and commit the baseline with the change. Each capture records the runtime it ran; after a change to what the runtime collects, re-capture.

Public pages only. Pages behind a login carry shop and product data: capture them locally, never commit them.

Nothing here ships: the desktop package takes `packages/desktop` and the built `@bcp/*` packages, and the extension ships its `.output/` build — neither includes this directory or the scripts that use it.

## Task benchmark (`tasks/`)

The census measures what a reply costs; `node scripts/snapshot-task-bench.mjs --checkout <dir> --label <name>` measures what an agent does with it. It starts the checkout's built backend (own ports from `--port-base`, default 18787–18789; weclaw off, and page and local scripts off so the agent works from the snapshot instead of reading the DOM with eval) and a headless Chromium with a throwaway profile and a copy of the checkout's built extension, then runs every task in `tasks/tasks.json` through `claude -p --output-format stream-json` with that MCP server as the only tool source (`--model sonnet`, `--max-turns 25`, 300 s per task, user settings not loaded). Prompts are cold: they state the goal and never name the control, its label or its state — naming it does the perceiving for the agent, and an earlier version that did so never once read the default snapshot view. Each run records how the agent read the page (default view, query, within, full, paging), so a result says whether the change under test was exercised. Each task is judged by its own deterministic check — tab URL, page state, or the `ANSWER:` line against a value read live from the page — and the run writes `tasks/results-<label>.json` (turns, tool calls, input tokens, snapshot characters, seconds per task). Everything it started is stopped on exit.

Run it on the PR base and the PR head with the same script; the success rate must not drop. Build both checkouts first (`pnpm --filter "@bcp/backend^..." build && pnpm --filter @bcp/backend build && pnpm --filter @bcp/extension build`) — a missing build, Chromium or `claude` CLI exits 2. Live pages drift, so compare runs taken close together, and treat a single failure as a lead to read in the transcript (in the `--logs` directory), not a verdict. Tasks behind a login (抖店, 1688) are listed in `tasks.json` and are run locally only.
