import { test } from "node:test";
import assert from "node:assert/strict";
import { claimDelivery } from "./delivery-claims.js";

test("concurrent delivery claims have one winner", async () => {
  let claimed = false;
  const store = {
    async updateMany() {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    },
  };
  const now = new Date();
  const results = await Promise.all([
    claimDelivery(store, "dr_1", now, "a", 60_000),
    claimDelivery(store, "dr_1", now, "b", 60_000),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("expired running claim is reclaimable with a new token", async () => {
  let args: { where: Record<string, unknown>; data: Record<string, unknown> } | undefined;
  const store = {
    async updateMany(input: typeof args) {
      args = input;
      return { count: 1 };
    },
  };
  const now = new Date("2026-08-23T00:00:00.000Z");
  assert.equal(await claimDelivery(store, "dr_1", now, "new", 60_000), true);
  assert.equal(args?.data.claimToken, "new");
  assert.equal((args?.data.claimUntil as Date).getTime(), now.getTime() + 60_000);
  assert.deepEqual(args?.data.attempts, { increment: 1 });
});
