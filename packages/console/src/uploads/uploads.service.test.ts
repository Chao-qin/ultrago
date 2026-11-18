import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPLOAD_MAX_BYTES } from "@bcp/shared";
import { UploadsService, sanitizeFilename } from "./uploads.service.js";

// Anchored on this file, not on cwd — `pnpm --filter` runs tests from
// packages/console, but the staging dir belongs to the monorepo root.
const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("a picked name is reduced to something that cannot leave uploads/", () => {
  assert.equal(sanitizeFilename("C:\\Users\\me\\photo.png"), "photo.png");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("报告 2026.pdf"), "报告 2026.pdf");
  assert.equal(sanitizeFilename(".."), "upload");
  assert.equal(sanitizeFilename(""), "upload");
  assert.equal(sanitizeFilename('a"b<c>d|e:f?g*h.txt'), "abcdefgh.txt");
});

test("staged bytes round-trip through a content-hashed name", () => {
  const uploads = new UploadsService();
  const bytes = Buffer.from("uploads-service-test-fixture-b7f1");
  const staged = uploads.save(bytes, "note.txt", "text/plain");
  try {
    assert.equal(staged.filename, "note.txt");
    assert.equal(staged.mimeType, "text/plain");
    assert.equal(staged.size, bytes.length);
    assert.match(staged.name, /^[0-9a-f]{16}-note\.txt$/);
    assert.equal(staged.url, `/api/uploads/${staged.name}`);
    assert.equal(path.basename(staged.localPath), staged.name);
    // Pin the DIRECTORY too, not just the file name. save() mkdirs its target
    // recursively, so a wrong UPLOADS_DIR silently creates a second staging
    // folder and every other assertion here still passes.
    assert.equal(path.dirname(staged.localPath), path.resolve(MONOREPO_ROOT, "resource/uploads"));
    assert.equal(uploads.resolveStored(staged.name), staged.localPath);
    assert.deepEqual(readFileSync(staged.localPath), bytes);
    // Same bytes, same file — re-picking does not grow the directory.
    assert.equal(uploads.save(bytes, "note.txt", "text/plain").localPath, staged.localPath);
  } finally {
    rmSync(staged.localPath, { force: true });
  }
});

test("a bogus mime falls back to the extension instead of being echoed", () => {
  const uploads = new UploadsService();
  const staged = uploads.save(Buffer.from("uploads-service-test-fixture-mime"), "shot.png", "not a mime type");
  try {
    assert.equal(staged.mimeType, "image/png");
  } finally {
    rmSync(staged.localPath, { force: true });
  }
});

test("empty and oversize bodies are refused before anything is written", () => {
  const uploads = new UploadsService();
  assert.throws(() => uploads.save(Buffer.alloc(0), "a.png", "image/png"), /empty/);
  assert.throws(() => uploads.save(Buffer.alloc(UPLOAD_MAX_BYTES + 1), "a.png", "image/png"), /too large/);
});

test("serving is scoped to direct children of uploads/", () => {
  const uploads = new UploadsService();
  assert.throws(() => uploads.resolveStored("../console.db"), /no staged upload/);
  assert.throws(() => uploads.resolveStored("nested/file.png"), /no staged upload/);
  assert.throws(() => uploads.resolveStored("never-written.png"), /no staged upload/);
});
