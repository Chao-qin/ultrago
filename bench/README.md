# bench/

Committed input data for the snapshot-size guard — not a scratch directory. CI reads it on every run.

| Path | What it is | Written by |
|---|---|---|
| `snapshots/<page>.json` | Raw `SnapshotElement[]` of a public page, captured by the real `bcpDomRuntime` at 1280×800, scrolled to the top. One element per line. | `pnpm --filter @bcp/extension snapshot:capture [page…]` |
| `snapshot-census.json` | Baseline per page: default-reply tokens, pages to read it all, elements listed. | `node scripts/snapshot-census.mjs --write` |

`pnpm check:snapshot` (CI step "Snapshot census") renders the snapshots with the backend's real renderer and fails when a default reply grows more than 5%, needs more pages, or lists a different number of elements than the baseline. When a change to the reply is intended, re-run `--write` and commit the baseline with the change.

Public pages only. Pages behind a login carry shop and product data: capture them locally, never commit them.

Nothing here ships: the desktop package takes `packages/desktop` and the built `@bcp/*` packages, and the extension ships its `.output/` build — neither includes this directory or the scripts that use it.
