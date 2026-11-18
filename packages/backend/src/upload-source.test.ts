import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUploadSource, resolveUploadSources } from "./upload-source.js";

test("resolveUploadSource reads a local file and derives its metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bcp-upload-source-"));
  const path = join(dir, "photo.png");
  await writeFile(path, Buffer.from("png-data"));
  try {
    const result = await resolveUploadSource({ localPath: path });
    assert.equal(result.filename, "photo.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.bytes, 8);
    assert.equal(Buffer.from(result.dataBase64, "base64").toString(), "png-data");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveUploadSource validates source cardinality and local paths", async () => {
  await assert.rejects(resolveUploadSource({}), /exactly one/);
  await assert.rejects(resolveUploadSource({ url: "https://example.com/a.png", localPath: "/tmp/a.png" }), /exactly one/);
  await assert.rejects(resolveUploadSource({ localPath: "/tmp/does-not-exist-bcp" }), /nothing is there/);
});

test("resolveUploadSource rejects private URLs before fetching", async () => {
  await assert.rejects(resolveUploadSource({ url: "http://127.0.0.1/private.png" }), /private\/loopback\/link-local/);
});

test("resolveUploadSource uses response metadata and caller filename for URLs", async () => {
  const body = Uint8Array.from([1, 2, 3]).buffer;
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    url: "https://cdn.example.com/original.png",
    headers: new Headers({ "content-type": "image/png", "content-length": "3" }),
    arrayBuffer: async () => body,
  })) as unknown as typeof fetch;
  const result = await resolveUploadSource(
    { url: "https://cdn.example.com/original.png", filename: "renamed.png" },
    { fetch: fetchImpl, lookup: async () => ({ address: "93.184.216.34" }) },
  );
  assert.equal(result.filename, "renamed.png");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes, 3);
});

test("resolveUploadSources preserves attachment order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bcp-upload-sources-"));
  const first = join(dir, "first.txt");
  const second = join(dir, "second.txt");
  await writeFile(first, "1");
  await writeFile(second, "2");
  try {
    const result = await resolveUploadSources([{ localPath: first }, { localPath: second }]);
    assert.deepEqual(result.map((item) => item.filename), ["first.txt", "second.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('URL download retries a transient connection failure and retains the image bytes', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    if (++attempts === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
    return new Response('image-data', { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  const result = await resolveUploadSource({ url: 'https://93.184.216.34/image.jpg' }, { fetch: fetchImpl });
  assert.equal(Buffer.from(result.dataBase64, 'base64').toString(), 'image-data');
  assert.equal(attempts, 2);
});

test('URL download reports its URL and underlying error after bounded retries', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  }) as typeof fetch;
  await assert.rejects(resolveUploadSource({ url: 'https://93.184.216.34/detail.jpg' }, { fetch: fetchImpl }), /detail.jpg.*3.*UND_ERR_CONNECT_TIMEOUT/s);
  assert.equal(attempts, 3);
});

test('URL download retries server errors but does not retry a missing file', async () => {
  let attempts = 0;
  let missing = false;
  const fetchImpl = (async () => {
    attempts++;
    return missing ? new Response('missing', { status: 404 }) : attempts === 1 ? new Response('unavailable', { status: 503 }) : new Response('image');
  }) as typeof fetch;
  assert.equal((await resolveUploadSource({ url: 'https://93.184.216.34/detail.jpg' }, { fetch: fetchImpl })).bytes, 5);
  assert.equal(attempts, 2);
  missing = true;
  await assert.rejects(resolveUploadSource({ url: 'https://93.184.216.34/missing.jpg' }, { fetch: fetchImpl }), /HTTP 404/);
  assert.equal(attempts, 3);
});
