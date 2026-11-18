import { test } from "node:test";
import assert from "node:assert/strict";
import { EVAL_TIMEOUT_MS, RpcMethod } from "@bcp/shared";
import { MUTATING, RECORDABLE_READS, TAB_SCOPED } from "./recordable-methods.js";
import { EVAL_RPC_TIMEOUT_MS } from "./ws-server.js";

test("WaitSignal: tab-scoped, read-only, and not a recordable action", () => {
  // It targets one tab (the run's bound page), never the user's active tab.
  assert.ok(TAB_SCOPED.has(RpcMethod.WaitSignal));
  // It never changes the page, so it must not trip manual-mode write guards.
  assert.ok(!MUTATING.has(RpcMethod.WaitSignal));
  // It is a WAIT, not a captured read: a signal wait is not a playbook step
  // result (gates are the wait mechanism; waitSignal is runner-internal).
  assert.ok(!RECORDABLE_READS.has(RpcMethod.WaitSignal));
});

test("eval's transport ceiling outlasts its page-side cap, whatever BCP_RPC_TIMEOUT_MS says", () => {
  // The page timer must fire first: it owns the error message and it is what
  // stops the injected async code. If the transport gave up first, the eval
  // would keep running in the page with nobody left to collect it.
  assert.ok(
    EVAL_RPC_TIMEOUT_MS > EVAL_TIMEOUT_MS,
    `transport ${EVAL_RPC_TIMEOUT_MS}ms must exceed page cap ${EVAL_TIMEOUT_MS}ms`,
  );
  // Derived, not configured — a hostile BCP_RPC_TIMEOUT_MS must not reach it.
  process.env.BCP_RPC_TIMEOUT_MS = "1000";
  assert.equal(EVAL_RPC_TIMEOUT_MS, EVAL_TIMEOUT_MS * 2);
  delete process.env.BCP_RPC_TIMEOUT_MS;
});
