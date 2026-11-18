import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordsController } from "./records.controller.js";
import { RecordsService } from "./records.service.js";

// Anchored on this file, not on cwd — same reasoning as records.service.test.ts.
const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const RECORDS_DIR = path.join(MONOREPO_ROOT, "resource/records");

/**
 * The response's Content-Type has to come from the ROW, not the file name, and
 * only a real HTTP round trip can show that: `res.sendFile` decides the header
 * inside express, so a direct method call proves nothing about what a client
 * receives.
 *
 * The bug is real data, not a hypothetical. `resource/records/ef5594d5df06e766-asldjas.md`
 * is 222 bytes of `{"conversationId": …, "reply": …}` — JSON stored under a
 * `.md` name because the doubao-ask book's `outputFile` parameter named it that
 * — and its row records `contentType = "application/json"`. Read out of
 * resource/db/console.db with node:sqlite in readOnly mode on 2026-08-28; two
 * more rows (`f7084a665a82c33e-meinv.md`, `df80dfaddfc7ee54-1122askdjask.md`)
 * are the same shape. The fixture below reproduces that mismatch exactly.
 */
const JSON_UNDER_MD = '{"conversationId":"38438883779009026","reply":"hi"}';

/** Boot the real controller behind real Nest/express routing with a fake
 *  Prisma, over a file that really exists on disk. `resolveStored` rejects a
 *  path to nothing, so a fixture that was never written would 404 for the wrong
 *  reason and prove nothing about the header. */
async function overHttp(
  fixtures: Record<string, string>,
  rowsByFileName: Record<string, { contentType: string }>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  mkdirSync(RECORDS_DIR, { recursive: true });
  for (const [name, body] of Object.entries(fixtures)) {
    writeFileSync(path.join(RECORDS_DIR, name), body);
  }
  const prisma = {
    schemaRecord: {
      findFirst: async ({ where }: { where: { fileName: string } }) => rowsByFileName[where.fileName] ?? null,
    },
  };

  @Module({
    controllers: [RecordsController],
    providers: [RecordsService, { provide: PrismaService, useValue: prisma }],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  try {
    await fn((await app.getUrl()).replace("[::1]", "127.0.0.1"));
  } finally {
    await app.close();
    for (const name of Object.keys(fixtures)) rmSync(path.join(RECORDS_DIR, name), { force: true });
  }
}

test("the served Content-Type is the row's, not the file extension's", async () => {
  const name = "bcp-ctrl-test-json-under-md.md";
  await overHttp({ [name]: JSON_UNDER_MD }, { [name]: { contentType: "application/json" } }, async (base) => {
    const res = await fetch(`${base}/api/records/${name}`);
    assert.equal(res.status, 200);
    // The load-bearing assertion. Unpatched this is "text/markdown", because
    // send@0.19.2 types the response off `.md` when nothing set the header
    // first. The database sniffed the bytes at landing time and recorded JSON;
    // that is the considered answer and the extension is the guess.
    assert.match(
      res.headers.get("content-type") ?? "",
      /^application\/json/,
      `expected the row's contentType, got ${res.headers.get("content-type")}`,
    );
    // The bytes still have to arrive — a header fix that broke the body would
    // otherwise pass.
    assert.equal(await res.text(), JSON_UNDER_MD);
  });
});

test("a file with no row behind it keeps the extension guess", async () => {
  const name = "bcp-ctrl-test-orphan.md";
  await overHttp({ [name]: "# a real markdown file" }, {}, async (base) => {
    const res = await fetch(`${base}/api/records/${name}`);
    assert.equal(res.status, 200);
    // Honest fallback: with no record there is no sniffed truth to prefer, so
    // sendFile's own extension lookup stands. This is also what proves the
    // override above is coming from the ROW rather than from a blanket header.
    assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
  });
});

test("the row can also correct in the other direction", async () => {
  // Not symmetric decoration: it pins that the row wins whatever it says,
  // rather than the fix happening to hard-code application/json.
  const name = "bcp-ctrl-test-md-under-json.json";
  await overHttp({ [name]: "# markdown" }, { [name]: { contentType: "text/markdown" } }, async (base) => {
    const res = await fetch(`${base}/api/records/${name}`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
  });
});

test("an unknown name is still a 404 and never consults the database", async () => {
  await overHttp({}, { "bcp-ctrl-test-never-written.md": { contentType: "application/json" } }, async (base) => {
    const res = await fetch(`${base}/api/records/bcp-ctrl-test-never-written.md`);
    assert.equal(res.status, 404, "resolveStored must reject before the row lookup");
  });
});
