import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { PageReadDumpStore } from "./browser-read-dump.js";

test("page text dump adapts chunk size and puts an overview in every file", async () => {
  const store = new PageReadDumpStore();
  const text = "A".repeat(25_000);
  const dump = await store.create({
    url: "https://example.test/long",
    title: "长页面",
    text,
    totalChars: text.length,
    overview: { headings: ["第一节", "第二节"], excerpt: "开头摘要" },
  });

  assert.equal(dump.chunkChars, 16_000);
  assert.equal(dump.chunkCount, 2);
  assert.equal(dump.chunks.reduce((n, c) => n + c.chars, 0), text.length);
  const first = await readFile(dump.chunks[0]!.path, "utf8");
  const second = await readFile(dump.chunks[1]!.path, "utf8");
  assert.match(first, /Page overview/);
  assert.match(first, /第一节/);
  assert.match(first, /第二节/);
  assert.match(second, /Page overview/);
  assert.match(second, /Range: 16000-25000 of 25000 characters/);
  assert.match(await readFile(dump.manifestPath, "utf8"), /"chunkCount": 2/);
  assert.match(await store.read(dump.chunks[1]!.path), /Range: 16000-25000/);

  await store.cleanup();
  await assert.rejects(() => access(dump.directory));
});

test("a new dump replaces the prior round and cleanup is idempotent", async () => {
  const store = new PageReadDumpStore();
  const first = await store.create({ url: "u1", title: "one", text: "one", totalChars: 3 });
  const second = await store.create({ url: "u2", title: "two", text: "two", totalChars: 3 });
  await assert.rejects(() => access(first.directory));
  await access(second.manifestPath);
  await store.cleanup();
  await store.cleanup();
  await assert.rejects(() => access(second.directory));
});
