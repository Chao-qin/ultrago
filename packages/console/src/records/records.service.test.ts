import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RecordsService, sanitizeFilename } from "./records.service.js";

// Anchored on this file, not on cwd — `pnpm --filter` runs tests from
// packages/console, but the store dir belongs to the monorepo root.
const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("a produced name is reduced to something that cannot leave records/", () => {
  assert.equal(sanitizeFilename("C:\\Users\\me\\report.md"), "report.md");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("报告 2026.pdf"), "报告 2026.pdf");
  assert.equal(sanitizeFilename(".."), "record");
  assert.equal(sanitizeFilename(""), "record");
  assert.equal(sanitizeFilename('a"b<c>d|e:f?g*h.txt'), "abcdefgh.txt");
});

test("stored bytes round-trip through a content-hashed name and dedupe on re-save", () => {
  const records = new RecordsService();
  const bytes = Buffer.from("records-service-test-fixture-c4a2");
  const stored = records.save(bytes, "report.md", "text/markdown");
  try {
    assert.equal(stored.mimeType, "text/markdown");
    assert.equal(stored.size, bytes.length);
    assert.match(stored.fileName, /^[0-9a-f]{16}-report\.md$/);
    assert.equal(stored.url, `/api/records/${stored.fileName}`);
    const localPath = path.join(MONOREPO_ROOT, "resource/records", stored.fileName);
    // Pin the DIRECTORY too, not just the file name. save() mkdirs its target
    // recursively, so a wrong RECORDS_DIR silently creates a second store
    // folder and every other assertion here still passes.
    assert.equal(records.resolveStored(stored.fileName), localPath);
    assert.deepEqual(readFileSync(localPath), bytes);
    // Same bytes, same file — re-saving does not grow the directory.
    const again = records.save(bytes, "report.md", "text/markdown");
    assert.equal(again.fileName, stored.fileName);
  } finally {
    rmSync(path.join(MONOREPO_ROOT, "resource/records", stored.fileName), { force: true });
  }
});

test("a bogus mime falls back to the extension instead of being echoed", () => {
  const records = new RecordsService();
  const stored = records.save(Buffer.from("records-service-test-fixture-mime"), "shot.png", "not a mime type");
  try {
    assert.equal(stored.mimeType, "image/png");
  } finally {
    rmSync(path.join(MONOREPO_ROOT, "resource/records", stored.fileName), { force: true });
  }
});

test("an empty body is refused before anything is written", () => {
  const records = new RecordsService();
  assert.throws(() => records.save(Buffer.alloc(0), "a.md", "text/markdown"), /empty/);
});

test("no size cap: a payload well over the uploads 25MB limit is still stored", () => {
  const records = new RecordsService();
  // UPLOAD_MAX_BYTES (uploads.service.ts) is 25 * 1024 * 1024 = 26,214,400 bytes.
  // records/ must not inherit that cap — this is the one behavior that differs
  // from uploads.service.ts, so it gets its own assertion rather than relying
  // on absence-of-a-throw elsewhere.
  const bytes = Buffer.alloc(26 * 1024 * 1024 + 1024, 7);
  const stored = records.save(bytes, "huge.bin", "application/octet-stream");
  try {
    assert.equal(stored.size, bytes.length);
  } finally {
    rmSync(path.join(MONOREPO_ROOT, "resource/records", stored.fileName), { force: true });
  }
});

test("serving is scoped to direct children of records/", () => {
  const records = new RecordsService();
  // Non-existent targets 404 regardless of the boundary check — real coverage
  // of "did we escape the dir" needs a file that actually EXISTS outside the
  // allowed set, otherwise a mutant that deletes the dirname() guard still
  // passes (existsSync() alone already rejects paths to nothing).
  const recordsDir = path.join(MONOREPO_ROOT, "resource/records");
  const escapedFile = path.join(MONOREPO_ROOT, "resource/escaped-record.txt");
  const nestedFile = path.join(recordsDir, "sub", "dir", "x");
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(escapedFile, "outside records/, must never be servable");
  mkdirSync(path.dirname(nestedFile), { recursive: true });
  writeFileSync(nestedFile, "nested inside records/, must not be a servable direct child");
  try {
    assert.throws(() => records.resolveStored("../escaped-record.txt"), /no stored record/);
    assert.throws(() => records.resolveStored("sub/dir/x"), /no stored record/);
    assert.throws(() => records.resolveStored("never-written.png"), /no stored record/);
  } finally {
    rmSync(escapedFile, { force: true });
    rmSync(path.join(recordsDir, "sub"), { recursive: true, force: true });
  }
});
