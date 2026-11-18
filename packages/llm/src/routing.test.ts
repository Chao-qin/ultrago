/**
 * Failover / retry-classification / demotion tests.
 *
 * Two of these guard against making things WORSE than no failover at all:
 * retrying a 401 turns one clear error into several identical ones, and
 * retrying after the response has started produces a corrupt answer that reads
 * like a complete one. Both are pinned below, and both were deliberately
 * mutated to confirm the assertions actually catch them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RequestError, UpstreamError, type ChannelConfig } from "./adapters/types.js";
import { createHealthTracker, isRetryable, withFailover } from "./routing.js";

function channel(id: string, host = "a.example.com"): ChannelConfig {
  return { id, adapter: "openai", baseUrl: `https://${host}`, model: `${id}-upstream` };
}

const A = channel("m", "a.example.com");
const B = channel("m", "b.example.com");
const C = channel("m", "c.example.com");

test("retryable classification follows the failure, not the wording", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryable(new UpstreamError("m", status)), true, `HTTP ${status}`);
  }
  // These describe the REQUEST, which does not improve by being sent elsewhere.
  for (const status of [400, 401, 403, 404, 413, 422, 501]) {
    assert.equal(isRetryable(new UpstreamError("m", status)), false, `HTTP ${status}`);
  }
  // Our own errors: a caller mistake, and our own spent deadline.
  assert.equal(isRetryable(new RequestError("bad model")), false);
  assert.equal(isRetryable(new RequestError("budget exhausted", 504)), false);

  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  assert.equal(isRetryable(aborted), false);

  // A bare network failure is the single best reason failover exists.
  assert.equal(isRetryable(new TypeError("fetch failed")), true);
});

test("a retryable failure moves to the next channel and succeeds there", async () => {
  const tried: string[] = [];
  const result = await withFailover([A, B], async (c) => {
    tried.push(c.baseUrl!);
    if (c === A) throw new UpstreamError("m", 429);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(tried, ["https://a.example.com", "https://b.example.com"]);
});

test("a NON-retryable failure stops immediately, without touching the others", async () => {
  const tried: string[] = [];
  await assert.rejects(
    withFailover([A, B, C], async (c) => {
      tried.push(c.baseUrl!);
      throw new UpstreamError("m", 401);
    }),
    (error: unknown) => error instanceof UpstreamError && error.upstreamStatus === 401,
  );
  assert.deepEqual(tried, ["https://a.example.com"], "a bad key is bad on every channel");
});

test("once the response has started, no further channel is tried", async () => {
  // The boundary that matters most: the status line and some chunks are already
  // on the wire. A second attempt cannot unsend them, and splicing a fresh
  // completion onto a half-sent one yields a corrupt answer that looks whole.
  const tried: string[] = [];
  let started = false;
  await assert.rejects(
    withFailover(
      [A, B],
      async (c) => {
        tried.push(c.baseUrl!);
        started = true; // pretend the first chunk went out
        throw new UpstreamError("m", 503); // retryable, but too late
      },
      { committed: () => started },
    ),
    (error: unknown) => error instanceof UpstreamError && error.upstreamStatus === 503,
  );
  assert.deepEqual(tried, ["https://a.example.com"]);
});

test("exhausting every candidate throws the LAST failure", async () => {
  await assert.rejects(
    withFailover([A, B], async (c) => {
      throw new UpstreamError("m", c === A ? 429 : 503);
    }),
    (error: unknown) => error instanceof UpstreamError && error.upstreamStatus === 503,
  );
});

test("an empty candidate list is a 503, not a hang", async () => {
  await assert.rejects(
    withFailover([], async () => "never"),
    (error: unknown) => error instanceof RequestError && error.status === 503,
  );
});

test("every failed attempt is reported, with its channel and ordinal", async () => {
  const seen: { host: string; attempt: number; willRetry: boolean }[] = [];
  await assert.rejects(
    withFailover(
      [A, B],
      async () => {
        throw new UpstreamError("m", 500);
      },
      {
        onAttemptFailed: ({ channel: c, attempt, willRetry }) =>
          seen.push({ host: new URL(c.baseUrl!).host, attempt, willRetry }),
      },
    ),
  );
  // Without this, an upstream that fails half the time and gets rescued by a
  // retry looks perfectly healthy in the call log.
  assert.deepEqual(seen, [
    { host: "a.example.com", attempt: 1, willRetry: true },
    { host: "b.example.com", attempt: 2, willRetry: false },
  ]);
});

test("a channel is demoted after repeated failures and tried LAST, never dropped", () => {
  const tracker = createHealthTracker();
  const now = 1_000_000;

  // Two failures are not enough — a blip should not reorder anything.
  tracker.recordFailure(A, now);
  tracker.recordFailure(A, now);
  assert.deepEqual(tracker.orderByHealth([A, B], now), [A, B]);

  tracker.recordFailure(A, now);
  assert.deepEqual(tracker.orderByHealth([A, B], now), [B, A], "demoted goes to the back");

  // Crucially it is still IN the list. If every source of a model is sick the
  // caller still needs us to try one — refusing outright would turn a degraded
  // model into an absent one.
  assert.deepEqual(tracker.orderByHealth([A], now), [A]);
});

test("demotion expires on its own, no probe bookkeeping needed", () => {
  const tracker = createHealthTracker();
  const now = 1_000_000;
  for (let i = 0; i < 3; i += 1) tracker.recordFailure(A, now);

  assert.deepEqual(tracker.orderByHealth([A, B], now + 29_000), [B, A]);
  assert.deepEqual(tracker.orderByHealth([A, B], now + 31_000), [A, B], "back on its own");
});

test("one success clears the streak", () => {
  const tracker = createHealthTracker();
  const now = 1_000_000;
  tracker.recordFailure(A, now);
  tracker.recordFailure(A, now);
  tracker.recordSuccess(A);
  tracker.recordFailure(A, now);
  // Would be the third consecutive failure if the success had not reset it.
  assert.deepEqual(tracker.orderByHealth([A, B], now), [A, B]);
});

test("two channels sharing an id are tracked separately", () => {
  // The whole point of a shared id is that they are DIFFERENT upstreams. Keying
  // on the bare id would let a dead vendor demote the healthy one beside it.
  const tracker = createHealthTracker();
  const now = 1_000_000;
  for (let i = 0; i < 3; i += 1) tracker.recordFailure(A, now);
  assert.deepEqual(tracker.orderByHealth([A, B], now), [B, A]);
  assert.equal(Object.keys(tracker.snapshot()).length, 1);
  assert.ok(tracker.snapshot()["m@a.example.com"]);
});

test("withFailover feeds the tracker, so a sick channel sinks over calls", async () => {
  const tracker = createHealthTracker();
  const attempt = async (c: ChannelConfig): Promise<string> => {
    if (c === A) throw new UpstreamError("m", 503);
    return "ok";
  };
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await withFailover([A, B], attempt, { tracker }), "ok");
  }
  // A has now failed three times in a row; the next call should start at B.
  const tried: string[] = [];
  await withFailover(
    [A, B],
    async (c) => {
      tried.push(new URL(c.baseUrl!).host);
      return attempt(c);
    },
    { tracker },
  );
  assert.deepEqual(tried, ["b.example.com"], "no wasted round trip through the sick one");
});
