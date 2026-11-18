import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConsoleDeliveryClient,
  MAX_INLINE_OUTPUTS_BYTES,
  type DurableDeliveryPayload,
} from "./console-delivery-client.js";

test("console delivery bridge durably ingests and removes an acknowledged outbox item", async () => {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const outbox = await mkdtemp(join(tmpdir(), "bcp-delivery-test-"));
  const client = new ConsoleDeliveryClient({ baseUrl: `http://127.0.0.1:${address.port}`, outboxDir: outbox });
  await client.ingest({
    runId: "run_1",
    planId: "plan_run_1",
    bookName: "book",
    trigger: "mcp",
    status: "cancelled",
    ranSteps: 0,
    totalSteps: 1,
    durationMs: 1,
    deliveries: [{ kind: "print", format: "markdown", on: "any" }],
  });
  assert.equal(received.length, 1);
  assert.equal((received[0] as { runId: string }).runId, "run_1");
  assert.deepEqual(await readdir(outbox), []);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("lazy: invalid console URL never fails construction (validated on use only)", () => {
  // Browser-only backends construct the client at boot; a misconfigured
  // BCP_CONSOLE_URL must not be able to fail that boot.
  const client = new ConsoleDeliveryClient({ baseUrl: "http://evil.example.com:8790" });
  assert.ok(client);
  // And it fails fast when the bridge is actually activated.
  assert.throws(() => client.start(), /loopback/);
});

test("lazy: recoverIfPending does nothing (no dir, no flush) when outbox is absent", async () => {
  const missing = join(tmpdir(), `bcp-no-outbox-${Date.now()}`);
  const client = new ConsoleDeliveryClient({ baseUrl: "http://127.0.0.1:1", outboxDir: missing });
  await client.recoverIfPending();
  // The outbox dir must NOT have been created by a boot that has nothing to recover.
  await assert.rejects(access(missing));
});

test("lazy: recoverIfPending resumes flushing when leftover outbox files exist", async () => {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const outbox = await mkdtemp(join(tmpdir(), "bcp-recover-test-"));
  // A leftover item from a previous run (backend crashed before flush).
  await writeFile(join(outbox, "leftover.json"), JSON.stringify({
    runId: "run_leftover", planId: "plan_leftover", bookName: "book",
    status: "failed", ranSteps: 0, totalSteps: 1, durationMs: 1, deliveries: [],
  }), "utf8");

  const client = new ConsoleDeliveryClient({ baseUrl: `http://127.0.0.1:${address.port}`, outboxDir: outbox });
  await client.recoverIfPending();
  // Recovery flush is async (timer + immediate flush) — wait for the item to land.
  for (let i = 0; i < 50 && received.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(received.length, 1);
  assert.equal((received[0] as { runId: string }).runId, "run_leftover");
  assert.deepEqual(await readdir(outbox), []);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("oversized outputs spill to disk and body stays small (no infinite retry)", async () => {
  // Wire-level assertion: the body the bridge actually POSTs is bounded. The
  // 140 MB JSON that triggered this whole fix used to round-trip the body
  // verbatim; the server (or fetch's body limit) rejected it, the bridge retried,
  // and nothing ever moved. If the body crosses MAX_INLINE_OUTPUTS_BYTES the
  // bridge has not actually fixed the bug.
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const outbox = await mkdtemp(join(tmpdir(), "bcp-spill-outbox-"));
  const spill = await mkdtemp(join(tmpdir(), "bcp-spill-"));

  // Build a payload whose serialized outputs dwarf the inline cap.
  const payload: DurableDeliveryPayload = {
    runId: "run_huge",
    planId: "plan_huge",
    bookName: "book",
    trigger: "mcp",
    status: "succeeded",
    ranSteps: 5,
    totalSteps: 5,
    durationMs: 1000,
    deliveries: [],
    outputs: { blob: "x".repeat(MAX_INLINE_OUTPUTS_BYTES * 3) },
  };
  // The spill metadata must round-trip the SAME byte count the bridge actually
  // wrote — not the size of the payload the bridge pretended to write. If
  // someone "optimises" by reporting bytes = original.value.byteLength, this
  // assertion catches it and an operator's "what does bytes mean?" question
  // gets answered by the test name.
  const expectedBytes = JSON.stringify(payload.outputs).length;
  assert.ok(expectedBytes > MAX_INLINE_OUTPUTS_BYTES, "test payload must actually exceed the cap");

  const client = new ConsoleDeliveryClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    outboxDir: outbox,
    spillDir: spill,
  });
  await client.ingest(payload);
  client.stop();

  assert.equal(bodies.length, 1, "exactly one POST should reach console");
  const sent = JSON.parse(bodies[0]!);
  // The whole point: the wire body must be bounded, not bounded by the original value.
  assert.ok(
    bodies[0]!.length < MAX_INLINE_OUTPUTS_BYTES,
    `wire body ${bodies[0]!.length} B should be < ${MAX_INLINE_OUTPUTS_BYTES} B`,
  );
  assert.equal(sent.outputs.__bcpOffloaded, true, "outputs is replaced with a spill ref");
  assert.equal(sent.outputs.path, join(spill, "run_huge.json"));
  assert.equal(sent.outputs.bytes, expectedBytes);
  // And the spilled file actually contains the original value — a ref that
  // points at nothing is worse than the inline form.
  const onDisk = JSON.parse(await readFile(join(spill, "run_huge.json"), "utf8"));
  assert.equal(onDisk.blob.length, MAX_INLINE_OUTPUTS_BYTES * 3);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("small outputs stay inline (no spill file is created)", async () => {
  // Negative control: the spill is a SIDE EFFECT, not a transform. If we spill
  // every run we silently change console's contract for everyone — test that
  // we don't.
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const outbox = await mkdtemp(join(tmpdir(), "bcp-nospill-outbox-"));
  const spill = await mkdtemp(join(tmpdir(), "bcp-nospill-"));

  const client = new ConsoleDeliveryClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    outboxDir: outbox,
    spillDir: spill,
  });
  await client.ingest({
    runId: "run_small",
    planId: "plan_small",
    bookName: "book",
    trigger: "mcp",
    status: "succeeded",
    ranSteps: 5,
    totalSteps: 5,
    durationMs: 1000,
    deliveries: [],
    outputs: { ok: true, count: 42 },
  });
  client.stop();

  assert.deepEqual(await readdir(spill), [], "no spill file for inline-sized outputs");
  const sent = JSON.parse(bodies[0]!);
  assert.equal(sent.outputs.ok, true);
  assert.equal(sent.outputs.count, 42);
  assert.equal(sent.outputs.__bcpOffloaded, undefined);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
