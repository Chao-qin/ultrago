import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveUploadSource, resolveUploadSources, type UploadSourceDeps } from "./upload-source.js";
import { isSpecialPurposeAddress } from "./public-fetch.js";

/** A real HTTP server on loopback, reached through a public-looking name. */
async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, body: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await body(`http://files.test:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

/** files.test is the test server (loopback, allowed here); internal.test is private and stays refused. */
const LOCAL: UploadSourceDeps = {
  lookup: async (host) => [{ address: host === "files.test" ? "127.0.0.1" : "10.0.0.5", family: 4 }],
  isBlockedAddress: (ip) => ip !== "127.0.0.1" && isSpecialPurposeAddress(ip),
};

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
  await assert.rejects(resolveUploadSource({ url: "http://127.0.0.1/private.png" }), /private, loopback or reserved/);
});

test("resolveUploadSource uses response metadata and caller filename for URLs", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([1, 2, 3]));
  }, async (origin) => {
    const result = await resolveUploadSource({ url: `${origin}/original.png`, filename: "renamed.png" }, LOCAL);
    assert.equal(result.filename, "renamed.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.bytes, 3);
  });
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

test("URL download retries a transient connection failure and retains the image bytes", async () => {
  let attempts = 0;
  await withServer((req, res) => {
    if (++attempts === 1) return req.socket.destroy(); // the connection drops mid-request
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end("image-data");
  }, async (origin) => {
    const result = await resolveUploadSource({ url: `${origin}/image.jpg` }, LOCAL);
    assert.equal(Buffer.from(result.dataBase64, "base64").toString(), "image-data");
    assert.equal(attempts, 2);
  });
});

test("URL download reports its URL and underlying error after bounded retries", async () => {
  let attempts = 0;
  await withServer((req) => {
    attempts++;
    req.socket.destroy();
  }, async (origin) => {
    await assert.rejects(resolveUploadSource({ url: `${origin}/detail.jpg` }, LOCAL), /detail\.jpg failed after 3 attempt\(s\).*ECONNRESET/s);
    assert.equal(attempts, 3);
  });
});

test("URL download retries server errors but does not retry a missing file", async () => {
  let attempts = 0;
  await withServer((req, res) => {
    attempts++;
    if (req.url === "/missing.jpg") return void res.writeHead(404).end("missing");
    if (attempts === 1) return void res.writeHead(503).end("unavailable");
    res.end("image");
  }, async (origin) => {
    assert.equal((await resolveUploadSource({ url: `${origin}/detail.jpg` }, LOCAL)).bytes, 5);
    assert.equal(attempts, 2);
    await assert.rejects(resolveUploadSource({ url: `${origin}/missing.jpg` }, LOCAL), /HTTP 404/);
    assert.equal(attempts, 3);
  });
});

test("URL download does not retry a refused address", async () => {
  let attempts = 0;
  await withServer((_req, res) => {
    attempts++;
    res.writeHead(302, { location: "http://internal.test/secret" }).end();
  }, async (origin) => {
    await assert.rejects(resolveUploadSource({ url: `${origin}/a.png` }, LOCAL), /internal\.test resolves to 10\.0\.0\.5/);
    assert.equal(attempts, 1, "a refusal is the same on every attempt");
  });
});
