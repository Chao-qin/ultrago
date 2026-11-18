import { test } from "node:test";
import assert from "node:assert/strict";
import { selectStartable } from "./dispatcher.service.js";

const pending = (n: number) => Array.from({ length: n }, (_, i) => ({ status: "pending", id: `p${i}` }));

test("with nothing running, the cap decides how many start", () => {
  assert.equal(selectStartable(pending(5), 0, 1).length, 1);
  assert.equal(selectStartable(pending(5), 0, 3).length, 3);
});

test("runs already underway consume the budget", () => {
  assert.equal(selectStartable(pending(5), 1, 1).length, 0);
  assert.equal(selectStartable(pending(5), 2, 3).length, 1);
});

test("a cap above 1 really does allow concurrency", () => {
  // Guards against writing the limit as "always serial" and never noticing:
  // the point of a cap is that raising it changes behaviour.
  assert.equal(selectStartable(pending(4), 0, 2).length, 2);
});

test("a stuck `starting` row is always retried, cap or no cap", () => {
  // Otherwise a run that failed to start would be blocked from recovering by
  // its own presence in the count.
  const rows = [{ status: "starting", id: "s" }, ...pending(3)];
  const chosen = selectStartable(rows, 5, 1);
  assert.deepEqual(chosen.map((r) => r.id), ["s"]);
});

test("starting rows do not eat the budget meant for new runs", () => {
  const rows = [{ status: "starting", id: "s" }, ...pending(3)];
  const chosen = selectStartable(rows, 0, 1);
  assert.deepEqual(chosen.map((r) => r.id), ["s", "p0"]);
});
