import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paramSpecsToJsonSchema, type ParamSpec } from "@bcp/shared";
import {
  FilesyncService,
  orphanBookNames,
  resolveParamSchema,
  resolveOutputSchema,
  type ResolveCtx,
} from "./filesync.service.js";

/** A registry standing in for `SchemasService.resolve`, holding only the field
 *  the resolvers read (`jsonSchema`, the stored TEXT — not a parsed object;
 *  a double that hands back an object would hide a missing JSON.parse).
 *
 *  Citations are keyed `name@version` and looked up EXACTLY. An unknown key
 *  throws the way the real service does rather than returning null, because
 *  "not registered" reaching the resolvers as a thrown NotFoundException is
 *  precisely the path the fallback exists to survive.
 *
 *  Every call is recorded, so a test can assert the registry was NOT consulted
 *  — otherwise "falls back to inline" would still pass for an implementation
 *  that queries first and discards the answer. */
function registry(rows: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    schemas: {
      resolve: async (name: string, version?: number) => {
        const key = version === undefined ? name : `${name}@${version}`;
        calls.push(key);
        const doc = rows[key];
        if (doc === undefined) throw new Error(`schema "${name}" v${version} not found`);
        return { jsonSchema: JSON.stringify(doc, null, 2) } as never;
      },
    },
  };
}

function ctxOver(rows: Record<string, unknown>): ResolveCtx & { warnings: string[]; calls: string[] } {
  const { schemas, calls } = registry(rows);
  const warnings: string[] = [];
  return { schemas, calls, warnings, book: "test-book", warn: (m) => warnings.push(m) };
}

const SPECS: ParamSpec[] = [
  { name: "reportFile", required: true, description: "输出文件", default: "out.json", schema: { type: "string", minLength: 1 } },
  { name: "limit", required: false, schema: { type: "number" } },
];

const NONEMPTY_STRING = { type: "string", minLength: 1 };

// ── paramSchemaRef ──────────────────────────────────────────────────────────

test("paramSchemaRef resolves from the registry, not from the inline params", async () => {
  // The two sides are DELIBERATELY different, so the assertion can tell which
  // one was used. Identical fixtures would pass either way.
  const registryDoc = paramSpecsToJsonSchema(SPECS, "test 入参契约");
  const ctx = ctxOver({ "book-input-test@1": registryDoc });

  const out = await resolveParamSchema(
    { params: [{ name: "stale", required: false }] as ParamSpec[], paramSchemaRef: "book-input-test@1" },
    ctx,
  );

  assert.deepStrictEqual(out, SPECS);
  assert.deepStrictEqual(ctx.calls, ["book-input-test@1"], "must resolve the pinned version, not the floating name");
});

test("no paramSchemaRef falls back to inline params without touching the registry", async () => {
  const ctx = ctxOver({ "book-input-test@1": paramSpecsToJsonSchema(SPECS) });

  const out = await resolveParamSchema({ params: SPECS }, ctx);

  assert.deepStrictEqual(out, SPECS);
  assert.deepStrictEqual(ctx.calls, [], "the registry must not be consulted when the book cites nothing");
  assert.deepStrictEqual(ctx.warnings, []);
});

test("legacy paramNames still derives inline when there is no ref", async () => {
  const ctx = ctxOver({});

  const out = await resolveParamSchema({ paramNames: ["a", "b"] }, ctx);

  assert.deepStrictEqual(out, [
    { name: "a", required: true, schema: { type: "string" } },
    { name: "b", required: true, schema: { type: "string" } },
  ]);
  assert.deepStrictEqual(ctx.calls, []);
});

test("an unresolvable paramSchemaRef warns and falls back — it does not throw", async () => {
  const ctx = ctxOver({}); // empty registry: nothing is registered yet

  const out = await resolveParamSchema({ params: SPECS, paramSchemaRef: "book-input-missing@1" }, ctx);

  assert.deepStrictEqual(out, SPECS, "the book must stay runnable on its inline contract");
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /cannot resolve schema "book-input-missing@1"/);
  assert.match(ctx.warnings[0], /falling back to the inline contract/);
});

test("a registry document that is not a JSON object warns and falls back", async () => {
  const ctx = ctxOver({ "book-input-test@1": ["not", "an", "object"] });

  const out = await resolveParamSchema({ params: SPECS, paramSchemaRef: "book-input-test@1" }, ctx);

  assert.deepStrictEqual(out, SPECS);
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /is not a JSON object/);
});

test("ref and inline disagreeing warns AND still produces the registry's answer", async () => {
  const registryDoc = paramSpecsToJsonSchema(SPECS, "test 入参契约");
  const ctx = ctxOver({ "book-input-test@1": registryDoc });
  const drifted: ParamSpec[] = [{ name: "reportFile", required: false, schema: { type: "string" } }];

  const out = await resolveParamSchema({ params: drifted, paramSchemaRef: "book-input-test@1" }, ctx);

  assert.deepStrictEqual(out, SPECS, "a mismatch must not block the sync — the registry wins, loudly");
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /inline params disagree with "book-input-test@1"/);
  assert.match(ctx.warnings[0], /using the registry/);
});

test("agreeing ref and inline warn about nothing even though the round trip reorders keys", async () => {
  // The regression this guards: paramSpecsToJsonSchema emits `description`
  // before `default`, while the playbook files spell them the other way round.
  // Comparing serializations instead of values would report drift on every
  // book that has both keys — a warning storm about contracts that agree.
  const inlineOrder = [
    { name: "reportFile", required: true, default: "out.json", description: "输出文件", schema: { type: "string", minLength: 1 } },
    { name: "limit", required: false, schema: { type: "number" } },
  ] as ParamSpec[];
  assert.notEqual(JSON.stringify(inlineOrder), JSON.stringify(SPECS), "fixture must actually differ byte-wise");

  const ctx = ctxOver({ "book-input-test@1": paramSpecsToJsonSchema(SPECS) });
  const out = await resolveParamSchema({ params: inlineOrder, paramSchemaRef: "book-input-test@1" }, ctx);

  assert.deepStrictEqual(out, SPECS);
  assert.deepStrictEqual(ctx.warnings, [], "key order is not drift");
});

// ── outputSchemaRef ─────────────────────────────────────────────────────────

test("outputSchemaRef resolves from the registry and re-serializes compactly", async () => {
  const ctx = ctxOver({ "book-output-nonempty-string@1": NONEMPTY_STRING });

  const out = await resolveOutputSchema(
    { outputSchema: NONEMPTY_STRING, outputSchemaRef: "book-output-nonempty-string@1" },
    ctx,
  );

  // The registry stores an indented canonical form; this column must not inherit
  // that formatting or the two branches write byte-different equal contracts.
  assert.equal(out, '{"type":"string","minLength":1}');
  assert.deepStrictEqual(ctx.warnings, []);
});

test("no outputSchemaRef and no outputSchema stays null, not '{}'", async () => {
  const ctx = ctxOver({});

  assert.equal(await resolveOutputSchema({}, ctx), null);
  assert.equal(await resolveOutputSchema({ outputSchema: NONEMPTY_STRING }, ctx), '{"type":"string","minLength":1}');
  assert.deepStrictEqual(ctx.calls, []);
});

test("an unresolvable outputSchemaRef warns and falls back to the inline outputSchema", async () => {
  const ctx = ctxOver({});

  const out = await resolveOutputSchema({ outputSchema: NONEMPTY_STRING, outputSchemaRef: "book-output-gone@1" }, ctx);

  assert.equal(out, '{"type":"string","minLength":1}');
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /cannot resolve schema "book-output-gone@1"/);
});

test("outputSchema disagreeing with its ref warns AND still produces the registry's answer", async () => {
  const ctx = ctxOver({ "book-output-nonempty-string@1": NONEMPTY_STRING });

  const out = await resolveOutputSchema(
    { outputSchema: { type: "object" }, outputSchemaRef: "book-output-nonempty-string@1" },
    ctx,
  );

  assert.equal(out, '{"type":"string","minLength":1}');
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /inline outputSchema disagrees with "book-output-nonempty-string@1"/);
});

// ── rescan() only writes when something actually changed ────────────────────
//
// These run against the real `resource/playbooks/` — read-only, and the point
// is that the second pass over the SAME bytes must be a no-op. The registry
// double refuses every citation so both passes fall back to inline identically;
// what is under test is the write decision, not the resolution.
function filesyncOver() {
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  let existing: Array<Record<string, unknown>> = [];
  const prisma = {
    book: {
      findMany: async () => existing,
      upsert: async (args: { create: Record<string, unknown> }) => {
        upserts.push(args);
        return {};
      },
    },
  };
  const schemas = {
    resolve: async () => {
      throw new Error("not registered");
    },
  };
  return {
    svc: new FilesyncService(prisma as never, schemas as never),
    upserts,
    setExisting: (rows: Array<Record<string, unknown>>) => {
      existing = rows;
    },
  };
}

/** The rows a first pass would have created, shaped like what `findMany`
 *  returns — i.e. what the database holds once that pass has run. */
async function afterFirstPass() {
  const h = filesyncOver();
  const { indexed, written, missing } = await h.svc.rescan();
  assert.ok(indexed > 0, "resource/playbooks/ must hold at least one valid playbook for this to test anything");
  assert.equal(h.upserts.length, indexed, "an empty table means every playbook is new, so every one is written");
  assert.equal(written, indexed, "and `written` must count them — asserting only the 0 case leaves it half-pinned");
  assert.deepEqual(missing, [], "an empty table has no rows to be missing a file");
  // `deletedAt: null` is what Prisma returns for a live row; the double would
  // otherwise omit the key entirely and the orphan scope would silently match
  // nothing, making every "missing" assertion below pass for the wrong reason.
  return {
    indexed,
    rows: h.upserts.map((u): Record<string, unknown> => ({ ...u.create, deletedAt: null })),
  };
}

test("rescan writes every playbook when the table is empty", async () => {
  const { indexed, rows } = await afterFirstPass();
  assert.equal(rows.length, indexed);
});

test("a second rescan over unchanged files writes nothing", async () => {
  // The whole point. `@updatedAt` fires on any update, identical data included,
  // so a rescan that upserts unconditionally rewrites every row every time —
  // which is what kept the tracked resource/db/console.db dirty.
  const { indexed, rows } = await afterFirstPass();
  const h = filesyncOver();
  h.setExisting(rows);
  const again = await h.svc.rescan();
  assert.equal(again.indexed, indexed, "still reports what it indexed, not what it wrote");
  assert.equal(again.written, 0, "and reports the write count separately");
  assert.deepEqual(h.upserts, [], "nothing changed on disk, so nothing may be written");
});

test("a changed derived value still writes, and only that book", async () => {
  // The counterpart: "writes nothing" must not be satisfiable by a rescan that
  // can no longer write at all.
  const { rows } = await afterFirstPass();
  const h = filesyncOver();
  const target = String(rows[0].name);
  h.setExisting(rows.map((r) => (r.name === target ? { ...r, paramSchema: '[{"name":"stale"}]' } : r)));
  await h.svc.rescan();
  assert.deepEqual(
    h.upserts.map((u) => u.create.name),
    [target],
    "exactly the book whose derived value drifted",
  );
});

test("a different fileMtime alone does not cause a write", async () => {
  // git rewrites mtimes on checkout. A byte-identical file arriving with a new
  // mtime is precisely the no-op write the skip exists to stop, so `fileMtime`
  // is written but never compared.
  const { rows } = await afterFirstPass();
  const h = filesyncOver();
  h.setExisting(rows.map((r) => ({ ...r, fileMtime: new Date(0) })));
  await h.svc.rescan();
  assert.deepEqual(h.upserts, [], "mtime is not part of the change decision");
});

// ── the DB side of the reconciliation ───────────────────────────────────────
// Until 2026-08-28 `rescan()` walked only the directory, so a Book row whose
// file had been deleted was never removed, flagged or logged — while the
// function's own doc comment claimed it warned and that the UI could show it
// as "stale". Neither existed. These pin the half that was missing.

test("a book with no file on disk is reported missing", async () => {
  const { rows } = await afterFirstPass();
  const h = filesyncOver();
  h.setExisting([...rows, { name: "ghost", deletedAt: null }]);
  const { missing } = await h.svc.rescan();
  assert.deepEqual(missing, ["ghost"]);
});

test("books that do have files are never reported missing", async () => {
  // The counterpart: "reports the ghost" must not be satisfiable by reporting
  // everything. Without this, `return [...existing]` passes the test above.
  const { rows } = await afterFirstPass();
  const h = filesyncOver();
  h.setExisting([...rows, { name: "ghost", deletedAt: null }]);
  const { missing } = await h.svc.rescan();
  for (const r of rows) {
    assert.ok(!missing.includes(String(r.name)), `${String(r.name)} has a file and must not be reported`);
  }
});

test("a soft-deleted book is not reported missing", async () => {
  // Its file being gone is not news — the user already withdrew the book.
  const { rows } = await afterFirstPass();
  const h = filesyncOver();
  h.setExisting([...rows, { name: "ghost", deletedAt: new Date() }]);
  const { missing } = await h.svc.rescan();
  assert.deepEqual(missing, []);
});

test("reporting a ghost does not write anything", async () => {
  // The report is a report. Soft-deleting on a missing file was considered and
  // rejected: there is no restore route, so a false positive would be
  // unrecoverable without hand-editing SQLite.
  const { rows } = await afterFirstPass();
  const h = filesyncOver();
  h.setExisting([...rows, { name: "ghost", deletedAt: null }]);
  await h.svc.rescan();
  assert.deepEqual(h.upserts, [], "an orphan row must not be touched");
});

test("orphanBookNames keys off filenames, not off books that parsed", () => {
  // The load-bearing distinction. A file that is present but momentarily
  // unparseable (half-written save, bad merge) is skipped by rescan's loop; if
  // the seen-set were built from the books that parsed, that book would be
  // reported as gone every time someone saved a broken edit.
  assert.deepEqual(orphanBookNames(["broken.json"], ["broken"]), [], "present-but-broken is not absent");
  assert.deepEqual(orphanBookNames([], ["gone"]), ["gone"]);
  assert.deepEqual(orphanBookNames(["a.json", "b.json"], ["b", "a"]), []);
  assert.deepEqual(orphanBookNames(["a.json"], ["c", "b"]), ["b", "c"], "sorted, so the log is stable");
});

test("an unreadable playbooks dir reports nothing rather than everything", async () => {
  const h = filesyncOver();
  h.setExisting([{ name: "ghost", deletedAt: null }]);
  const svc = new FilesyncService({} as never, {} as never);
  // Point the service at a directory that does not exist.
  (svc as unknown as { playbooksDir: string }).playbooksDir = "/nonexistent-playbooks-dir";
  const { indexed, written, missing } = await svc.rescan();
  assert.equal(indexed, 0);
  assert.equal(written, 0);
  assert.deepEqual(missing, [], "we could not ask the question, so we must not answer it");
});

test("a file that is present but unparseable does not make its book look deleted", async () => {
  // The orphan set is built from FILENAMES, and this is the case that proves
  // it. Every fixture in resource/playbooks/ parses cleanly, so the tests above
  // — including the pure-function one — never exercise the argument the call
  // site actually passes; a rescan rebuilt to key off the books that PARSED
  // would sail through all of them. A real directory with a real broken file
  // is the only thing that pins it.
  //
  // The stakes: a half-written save or a bad merge would otherwise report the
  // book as gone from disk, which is the one thing this report must never get
  // wrong — it is the signal a person acts on by deleting the book.
  const dir = mkdtempSync(join(tmpdir(), "bcp-filesync-"));
  try {
    writeFileSync(join(dir, "broken.json"), "{ this is not json");
    writeFileSync(join(dir, "shaped-wrong.json"), JSON.stringify({ goal: "no name, no steps" }));
    writeFileSync(join(dir, "good.json"), JSON.stringify({ name: "good", goal: "g", steps: [] }));

    const h = filesyncOver();
    h.setExisting([
      { name: "broken", deletedAt: null },
      { name: "shaped-wrong", deletedAt: null },
      { name: "good", deletedAt: null },
    ]);
    (h.svc as unknown as { playbooksDir: string }).playbooksDir = dir;

    const { indexed, missing } = await h.svc.rescan();
    assert.equal(indexed, 1, "only `good` is indexable — the other two are skipped by the parse loop");
    assert.deepEqual(missing, [], "all three files are on disk; two are broken, none are gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
