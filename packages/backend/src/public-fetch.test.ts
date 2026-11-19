/**
 * fetchPublicUrl refuses non-public addresses where the connection is made —
 * on every redirect hop and on the address the socket actually uses — not in a
 * pre-check the request itself then bypasses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPublicUrl, isSpecialPurposeAddress, type PublicFetchDeps } from "./public-fetch.js";

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, body: (port: number) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await body((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

/** Names → addresses for the test; loopback stands in for "public" and is the only address allowed. */
const deps = (names: Record<string, string[]>): PublicFetchDeps => ({
  lookup: async (host) => (names[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  isBlockedAddress: (ip) => ip !== "127.0.0.1" && isSpecialPurposeAddress(ip),
});
const OPTS = { timeoutMs: 5000, maxBytes: 1024 };

test("a redirect to a private host is refused before any connection to it", async () => {
  await withServer((_req, res) => res.writeHead(302, { location: "http://intranet.test/admin" }).end(), async (port) => {
    await assert.rejects(
      fetchPublicUrl(`http://cdn.test:${port}/a.png`, OPTS, deps({ "cdn.test": ["127.0.0.1"], "intranet.test": ["192.168.1.10"] })),
      /intranet\.test resolves to 192\.168\.1\.10/,
    );
  });
});

test("a redirect to a literal private address is refused", async () => {
  await withServer((_req, res) => res.writeHead(307, { location: "http://169.254.169.254/latest/meta-data" }).end(), async (port) => {
    await assert.rejects(fetchPublicUrl(`http://cdn.test:${port}/a.png`, OPTS, deps({ "cdn.test": ["127.0.0.1"] })), /private, loopback or reserved/);
  });
});

test("a name that also resolves to a private address is refused, whatever the order", async () => {
  await withServer((_req, res) => res.end("x"), async (port) => {
    await assert.rejects(fetchPublicUrl(`http://mixed.test:${port}/`, OPTS, deps({ "mixed.test": ["127.0.0.1", "10.1.2.3"] })), /resolves to 10\.1\.2\.3/);
  });
});

test("redirects between public hosts are followed, and the final URL is reported", async () => {
  await withServer((req, res) => {
    if (req.url === "/start") return void res.writeHead(301, { location: "/final.png" }).end();
    res.writeHead(200, { "content-type": "image/png" }).end("png");
  }, async (port) => {
    const res = await fetchPublicUrl(`http://cdn.test:${port}/start`, OPTS, deps({ "cdn.test": ["127.0.0.1"] }));
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "png");
    assert.equal(res.url, `http://cdn.test:${port}/final.png`);
  });
});

test("a redirect loop stops at the hop limit", async () => {
  await withServer((_req, res) => res.writeHead(302, { location: "/again" }).end(), async (port) => {
    await assert.rejects(fetchPublicUrl(`http://cdn.test:${port}/`, OPTS, deps({ "cdn.test": ["127.0.0.1"] })), /too many redirects/);
  });
});

test("a body over the cap is refused while it streams, with or without content-length", async () => {
  await withServer((req, res) => {
    if (req.url === "/declared") return void res.writeHead(200, { "content-length": "4096" }).end(Buffer.alloc(4096));
    res.write(Buffer.alloc(800));
    res.end(Buffer.alloc(800));
  }, async (port) => {
    const d = deps({ "cdn.test": ["127.0.0.1"] });
    await assert.rejects(fetchPublicUrl(`http://cdn.test:${port}/declared`, OPTS, d), /too large \(4096B > 1024B/);
    await assert.rejects(fetchPublicUrl(`http://cdn.test:${port}/chunked`, OPTS, d), /too large \(more than 1024B/);
  });
});

test("an error status is reported as the status, whatever the size of its body", async () => {
  await withServer((_req, res) => res.writeHead(404, { "content-length": "4096" }).end(Buffer.alloc(4096)), async (port) => {
    const res = await fetchPublicUrl(`http://cdn.test:${port}/gone.png`, OPTS, deps({ "cdn.test": ["127.0.0.1"] }));
    assert.equal(res.status, 404);
    assert.equal(res.body.length, 0);
  });
});

test("each hop gets its own headers, and the timeout covers redirects and the body", async () => {
  const referers: string[] = [];
  await withServer((req, res) => {
    referers.push(String(req.headers.referer));
    if (req.url === "/start") return void res.writeHead(302, { location: `http://img.test:${(req.socket.localPort)}/stall` }).end();
    res.writeHead(200);
    res.write("partial"); // and never ends
  }, async (port) => {
    const d = deps({ "cdn.test": ["127.0.0.1"], "img.test": ["127.0.0.1"] });
    const started = Date.now();
    await assert.rejects(
      fetchPublicUrl(`http://cdn.test:${port}/start`, { ...OPTS, timeoutMs: 400, headers: (u) => ({ Referer: `${u.origin}/` }) }, d),
    );
    assert.ok(Date.now() - started < 2000, "the stalled body is cut off by the request's own timeout");
    assert.deepEqual(referers, [`http://cdn.test:${port}/`, `http://img.test:${port}/`]);
  });
});

test("special-purpose addresses, including IPv4 carried inside IPv6", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "fec0::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1",
    "::ffff:0:7f00:1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2002:c0a8:101::1", "not-an-ip"])
    assert.equal(isSpecialPurposeAddress(ip), true, `${ip} is refused`);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])
    assert.equal(isSpecialPurposeAddress(ip), false, `${ip} is public`);
});
