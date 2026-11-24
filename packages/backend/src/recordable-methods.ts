/**
 * recordable-methods.ts — the canonical "which browser RPCs produce a step
 * result" sets, shared by BOTH playback channels:
 * - browser-mcp.ts uses them to decide which tool calls noteAction() (what
 *   lands a step's data in PlanRunner.getResults for later local.* steps, and
 *   what makes an action recordable into a playbook);
 * - internal-runner.ts uses them for the same noteAction decision on its
 *   console path (without it, getResults() stays empty and fail-closed books
 *   always fail — learn.md 2026-08-21).
 * Keep this the single source of truth — a new recordable RPC must be added
 * HERE, not in one channel.
 */

import { MUTATING_METHODS, RpcMethod, TAB_SCOPED_METHODS } from "@bcp/shared";

/** Ops that CHANGE the page (writes) — refused on the user's visible tab in
 * manual mode. Read ops (snapshot/page_state/screenshot/read_content) are
 * harmless there, so they're excluded. */
export const MUTATING = new Set<RpcMethod>(MUTATING_METHODS);

/** Read-only ops that a RECORDING plan may also capture (in addition to
 * MUTATING), so a playbook can carry a "read the data" step alongside its
 * clicks/types. Deliberately NOT merged into MUTATING: that set also gates
 * BCP_FORCE_PLAN and the foreground-visibility check, neither of which a
 * pure read should trip. Kept minimal (only what's actually been needed) —
 * extend when a real use case shows up, not speculatively. */
export const RECORDABLE_READS = new Set<RpcMethod>([RpcMethod.Eval, RpcMethod.ReadContent]);

/** RPCs that fall back to "the active tab" when `tabId` is omitted — exactly
 * the calls that could silently touch the USER's view. Used by:
 * - browser-mcp's call(): default an omitted tabId to the session's CLAIMED tab;
 * - playback's trackedCall(): default an omitted tabId to the RUN's own tab
 *   (the last one it opened) — this is what keeps a console-path playbook from
 *   typing/clicking into whatever the user happens to be looking at. */
export const TAB_SCOPED = new Set<RpcMethod>(TAB_SCOPED_METHODS);
