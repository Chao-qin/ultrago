import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareFlowNodesByExecution,
  type FlowNodeExecutionOrderRow,
} from "./flows.service.js";

/** Compact shorthand so the table-shaped test cases stay readable. */
const row = (
  nodeId: string,
  startedAtMs: number | null,
  extras: Partial<FlowNodeExecutionOrderRow> = {},
): FlowNodeExecutionOrderRow => ({
  nodeId,
  iteration: extras.iteration ?? null,
  startedAt: startedAtMs == null ? null : new Date(startedAtMs),
  createdAt: extras.createdAt ?? new Date(0),
});

/** Sort a copy of the input so the assertions show the "after" ordering. */
const sortByExecution = (rows: FlowNodeExecutionOrderRow[]) =>
  [...rows].sort(compareFlowNodesByExecution).map((r) => r.nodeId);

test("orders by startedAt ascending when every row has a timestamp", () => {
  // The cbbed046 case from the live DB: alphabetical order would put
  // book-capture first, then flow-input, then script-preprocess — which is
  // exactly backwards from the real execution.
  const rows = [
    row("flow-input", 1_789_173_042_856),
    row("script-preprocess", 1_789_173_051_086),
    row("book-capture", 1_789_173_043_050),
  ];
  assert.deepEqual(sortByExecution(rows), [
    "flow-input",
    "book-capture",
    "script-preprocess",
  ]);
});

test("rows with null startedAt trail rows with a real startedAt", () => {
  // A live run plus a node that was just enqueued and hasn't started yet.
  // Pending nodes must NOT pop to the top under ASC NULLS FIRST.
  const rows = [
    row("deliver", null),                       // pending, just enqueued
    row("script-preprocess", 1_789_173_051_086),
    row("book-capture", 1_789_173_043_050),
    row("flow-input", 1_789_173_042_856),
  ];
  assert.deepEqual(sortByExecution(rows), [
    "flow-input",
    "book-capture",
    "script-preprocess",
    "deliver",
  ]);
});

test("ties on startedAt fall back to iteration, then nodeId", () => {
  // Same millisecond is the common case for map expansions stamped in the
  // same tick. Within that group we want iteration ASC (the unique key
  // shape) and nodeId ASC for full determinism.
  const rows = [
    row("s", 1_000, { iteration: 2 }),
    row("s", 1_000, { iteration: 0 }),
    row("s", 1_000, { iteration: 1 }),
    row("t", 1_000),
  ];
  assert.deepEqual(sortByExecution(rows), ["s", "s", "s", "t"]);
});

test("null-startedAt rows fall back to createdAt then iteration then nodeId", () => {
  // Two pending rows that were minted at different times: the older one
  // should come first (it has been waiting longer).
  const rows = [
    row("deliver", null, { createdAt: new Date(2_000) }),
    row("collect", null, { createdAt: new Date(1_000) }),
    row("flow-output", null, { createdAt: new Date(1_500) }),
  ];
  assert.deepEqual(sortByExecution(rows), ["collect", "flow-output", "deliver"]);
});

test("returns a stable order across repeated sorts of the same input", () => {
  // Determinism matters because the timeline re-sorts on every React render
  // — if the comparator ever returned 0 for two different rows, React's
  // keyed reconciliation would jitter and DOM nodes would mount/unmount.
  const rows = [
    row("c", 1_000),
    row("a", 500),
    row("b", 1_500),
    row("d", null, { createdAt: new Date(800) }),
  ];
  const first = sortByExecution(rows);
  const second = sortByExecution(rows);
  const third = sortByExecution([...rows].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test("does not mutate the input array (Array.prototype.sort is in place)", () => {
  const rows = [
    row("b", 2_000),
    row("a", 1_000),
    row("c", null),
  ];
  const snapshot = rows.map((r) => r.nodeId);
  [...rows].sort(compareFlowNodesByExecution);
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    snapshot,
    "caller's array must be untouched; getRun() spreads first",
  );
});

test("mixed map iteration rows interleave correctly with their parent map node", () => {
  // Map parent has no iteration (it's the parent node); iteration rows are
  // the children. Same nodeId, different iteration values. Order:
  //   - map parent (startedAt = 1_000) comes first because of its timestamp
  //   - iteration 0, 1, 2 of "s" share startedAt=2_000 → ordered by iteration
  const rows = [
    row("s", 2_000, { iteration: 2 }),
    row("m", 1_000),
    row("s", 2_000, { iteration: 0 }),
    row("s", 2_000, { iteration: 1 }),
  ];
  assert.deepEqual(sortByExecution(rows), ["m", "s", "s", "s"]);
});
