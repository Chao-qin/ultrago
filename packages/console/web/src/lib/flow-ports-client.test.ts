import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dropEdgesForGonePorts, matchingConnections, newNodeConfig, resolvePortsClient, schemaLookup, withFrozenPortIds } from "./flow-ports-client.js";
import type { ParamSpec } from "@bcp/shared";
import type { FlowGraph, FlowNode, FlowPort, SchemaRow } from "./types";

/**
 * The browser half of "a flowInput may cite the Schema registry".
 *
 * `flow-types.test.ts` proves the shared helper, `flows.service.test.ts` proves
 * the server's two seams. This file is the third one: the lookup the canvas and
 * the trigger dialog run, which has no database behind it and answers from a
 * list the page already fetched. It has to reach the SAME document
 * `SchemasService.resolve` would, or the dialog asks for fields the handles say
 * do not exist.
 */

function row(over: Partial<SchemaRow> & { name: string; version: number; jsonSchema: string }): SchemaRow {
  return {
    id: `${over.name}@${over.version}`, kind: "book_input", entity: null, title: null, description: null,
    contentHash: "h", source: "api", upstreamRef: null, derivesFrom: null, active: true,
    createdAt: "", updatedAt: "", ...over,
  } as SchemaRow;
}
const doc = (props: Record<string, unknown>, required: string[] = []) => JSON.stringify({ type: "object", required, properties: props });

const V1 = row({ name: "book-input-x", version: 1, jsonSchema: doc({ legacy: { type: "string" } }) });
const V2 = row({ name: "book-input-x", version: 2, jsonSchema: doc({ keyword: { type: "string" }, limit: { type: "number" } }, ["keyword"]) });

const citing = (id: string, ref: { name: string; version?: number }): FlowNode =>
  ({ id, type: "flowInput", position: { x: 0, y: 0 }, config: { params: [], schemaRef: ref } } as never);
const listing = (id: string, names: string[]): FlowNode =>
  ({ id, type: "flowInput", position: { x: 0, y: 0 }, config: { params: names.map((name) => ({ name, required: false })) } } as never);
const only = (nodes: FlowNode[]): FlowGraph => ({ nodes, edges: [] });

test("a citing flowInput grows one out port per cited property", () => {
  const ports = resolvePortsClient(only([citing("i1", { name: "book-input-x" })]), [], [V1, V2]);
  assert.deepEqual(ports.get("i1")!.map((p) => p.id), ["keyword", "limit"]);
  assert.ok(ports.get("i1")!.every((p) => p.direction === "out"), "the flow's inputs LEAVE this node");
  assert.deepEqual(ports.get("i1")![0].schema, { type: "string" }, "each port carries its own field's schema, which is what wires are judged against");
});

test("a listing flowInput is untouched, and inline params still win over a citation", () => {
  assert.deepEqual(resolvePortsClient(only([listing("i1", ["a", "b"])]), [], [V1, V2]).get("i1")!.map((p) => p.id), ["a", "b"]);
  const both: FlowNode = {
    id: "i2", type: "flowInput", position: { x: 0, y: 0 },
    config: { params: [{ name: "typed", required: false }], schemaRef: { name: "book-input-x" } } as never,
  };
  assert.deepEqual(resolvePortsClient(only([both]), [], [V1, V2]).get("i2")!.map((p) => p.id), ["typed"]);
});

test("an unpinned citation resolves to the highest ACTIVE version, exactly as SchemasService.resolve does", () => {
  // The server's rule, in SQL: WHERE name = ? AND deletedAt IS NULL AND active
  // ORDER BY version DESC LIMIT 1. Every clause of it is asserted here, because
  // this side reads an array and can only get the same answer by construction.
  const props = (r: unknown) => Object.keys((r as { properties: object }).properties);
  assert.deepEqual(props(schemaLookup([V1, V2])({ name: "book-input-x" })), ["keyword", "limit"]);
  assert.deepEqual(props(schemaLookup([V2, V1])({ name: "book-input-x" })), ["keyword", "limit"], "list order must not decide it");
  const retired = { ...V2, active: false };
  assert.deepEqual(props(schemaLookup([V1, retired])({ name: "book-input-x" })), ["legacy"], "a retired newest falls back to the newest still active");
  assert.equal(schemaLookup([{ ...V1, active: false }, retired])({ name: "book-input-x" }), null, "nothing active is a 404 on the server and null here");
});

test("a pin selects that exact version, and an unknown citation degrades to null", () => {
  assert.deepEqual(Object.keys((schemaLookup([V1, V2])({ name: "book-input-x", version: 1 }) as { properties: object }).properties), ["legacy"]);
  assert.equal(schemaLookup([V1, V2])({ name: "book-input-x", version: 9 }), null);
  assert.equal(schemaLookup([V1, V2])({ name: "nope" }), null);
  assert.equal(schemaLookup([])({ name: "book-input-x" }), null, "an empty registry is a fresh database, not an error");
});

test("a document that is not a JSON object yields no ports rather than throwing", () => {
  // The server degrades the same way (`parseJsonSchema` in flows.service.ts),
  // and both pick the SAME row before parsing it — so an unparseable newest
  // version makes both sides return null rather than one of them silently
  // falling back to an older document the other never considered.
  for (const junk of ["not json", "[1,2]", "null", '"a string"']) {
    const bad = row({ name: "junk", version: 1, jsonSchema: junk });
    assert.equal(schemaLookup([bad])({ name: "junk" }), null, junk);
    assert.deepEqual(resolvePortsClient(only([citing("i1", { name: "junk" })]), [], [bad]).get("i1"), [], junk);
  }
});

// ── script: inline contract wins over registry citation ──────────────────

const scriptInlineWinsRef = (id: string): FlowNode =>
  ({
    id,
    type: "script",
    position: { x: 0, y: 0 },
    config: {
      inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
      inputSchemaRef: { name: "book-input-x" },
      outputSchema: { type: "object", properties: { ready: { type: "boolean" } } },
      outputSchemaRef: { name: "book-input-x" },
    },
  } as never);

test("script ports honour inline inputSchema when both inline and ref are present", () => {
  // Mirrors `FlowOutputNodeConfig`: inline-first, ref is the fallback for when
  // there is nothing to inline. The ref row is still in the registry, but the
  // ports come from the inline schema — the citation is dormant here.
  const ports = resolvePortsClient(only([scriptInlineWinsRef("s1")]), [], [V1, V2]).get("s1")!;
  assert.deepEqual(
    ports.filter((p) => p.direction === "in").map((p) => p.id),
    ["a", "b"],
    "inline inputSchema wins over the registry citation",
  );
  const out = ports.find((p) => p.direction === "out");
  assert.deepEqual(out?.id, "output");
  assert.deepEqual(out?.schema, { type: "object", properties: { ready: { type: "boolean" } } });
  assert.equal(out?.schemaRef, undefined, "the citation is dormant once inline is present, so it must not be surfaced as the source of truth");
});

// ── a port outlives the name on it ───────────────────────────────

/**
 * A handle is a port's STABLE id, so an author renaming a parameter is not an
 * event this function can even see. It was, until `portId`: the id was the
 * name, so a rename read as a delete plus an insert, the wire was left on a
 * handle that had ceased to exist, and React Flow — which will not draw an edge
 * it cannot anchor — dropped the line off the canvas while the edge stayed in
 * the graph, unselectable and fatal to every save. Reported as "为什么无法
 * 连线", with two stranded edges naming two earlier spellings of one parameter.
 *
 * What is left for this to do is deletions, which are still real: the port goes
 * and the wire has nowhere to be.
 */
const wire = (id: string, source: string, sourceHandle: string) => ({ id, source, sourceHandle, target: "s1", targetHandle: "input" });

test("a rename is invisible here, because the id it would have changed no longer moves", () => {
  const edges = [wire("e1", "in1", "p_aaa"), wire("e2", "in1", "p_bbb")];
  // param1 → 名字 → name1, the sequence from the report: three names, one id.
  assert.equal(dropEdgesForGonePorts(edges, "in1", ["p_aaa", "p_bbb"], ["p_aaa", "p_bbb"]), edges);
  assert.deepEqual(
    resolvePortsClient(only([{ id: "in1", type: "flowInput", position: { x: 0, y: 0 }, config: { params: [{ name: "name1", portId: "p_aaa", required: false }] } } as never]), [], [])
      .get("in1")!
      .map((p) => [p.id, p.label]),
    [["p_aaa", "name1"]],
    "the handle is the stable id; the label is whatever the author last typed",
  );
});

test("a parameter written before portId existed keeps the handle it always had", () => {
  // The whole no-migration argument, in one assertion: absent `portId` falls
  // back to the name, which is the exact string every stored edge already
  // names, so old graphs resolve unchanged.
  const legacy = listing("in1", ["a", "b"]);
  assert.deepEqual(resolvePortsClient(only([legacy]), [], []).get("in1")!.map((p) => p.id), ["a", "b"]);
});

test("freezing pins a legacy parameter's handle to the exact string it already resolved to", () => {
  // The no-migration claim, made testable: freeze must not MOVE anything. The
  // ports before and after are the same ports, so every stored edge that
  // resolved yesterday resolves after this runs, and the server reading the
  // still-unfrozen graph agrees with the canvas reading the frozen one.
  const legacy = listing("in1", ["a", "b"]);
  const frozen = withFrozenPortIds(legacy);
  const idsOf = (n: FlowNode) => resolvePortsClient(only([n]), [], []).get("in1")!.map((p) => p.id);
  assert.deepEqual(idsOf(frozen), idsOf(legacy));
  assert.deepEqual((frozen.config as { params: ParamSpec[] }).params.map((p) => p.portId), ["a", "b"]);

  // And having been pinned, a rename no longer reaches the handle.
  const renamed = { ...frozen, config: { params: [{ name: "改过了", portId: "a", required: false }, { name: "b", portId: "b", required: false }] } } as FlowNode;
  assert.deepEqual(idsOf(renamed), ["a", "b"], "the label moved, the handle did not");
});

test("freezing leaves alone what it has no business touching", () => {
  const already = { id: "in1", type: "flowInput", position: { x: 0, y: 0 }, config: { params: [{ name: "n", portId: "p_x", required: false }] } } as FlowNode;
  assert.equal(withFrozenPortIds(already), already, "the same node back: nothing to pin, so nothing is rewritten");
  const citing = { id: "in1", type: "flowInput", position: { x: 0, y: 0 }, config: { params: [], schemaRef: { name: "book-input-x" } } } as FlowNode;
  assert.equal(withFrozenPortIds(citing), citing, "a citation has no inline params to pin");
  const book = { id: "b1", type: "book", position: { x: 0, y: 0 }, config: { bookId: "x" } } as FlowNode;
  assert.equal(withFrozenPortIds(book), book, "only a flowInput names its own ports");
});

test("a node dropped on the canvas is born with stable handles, not with handles named after its rows", () => {
  // The regression this exists for: seeding `{ name: "param1" }` with no
  // portId let the handle fall back to the NAME, so the first rename moved it
  // and took the wire with it. Every OTHER test passed while that was true,
  // because they all start from rows that already have ids.
  const seeded = newNodeConfig("flowInput") as { params: ParamSpec[] };
  assert.ok(seeded.params.every((p) => p.portId), "every seeded parameter carries a portId");
  assert.notEqual(seeded.params[0].portId, seeded.params[0].name, "and it is not the name, or the fallback is back");

  // Renaming it must now leave the handle where it is — the whole point.
  const born: FlowNode = { id: "in1", type: "flowInput", position: { x: 0, y: 0 }, config: seeded } as never;
  const handle = () => resolvePortsClient(only([born]), [], []).get("in1")!.map((p) => p.id);
  const before = handle();
  (born as { config: unknown }).config = { params: [{ ...seeded.params[0], name: "改过了" }] };
  assert.deepEqual(handle(), before);

  const t = newNodeConfig("transform") as { outputs: Array<{ id: string; label?: string }> };
  assert.ok(t.outputs.every((o) => o.id && o.label), "a transform output is born with both halves too");
  assert.notEqual(t.outputs[0].id, t.outputs[0].label);

  assert.deepEqual(newNodeConfig("script"), {}, "a script's ports are fixed, so it seeds nothing");
});

test("batch matching connects compatible same-named fields and skips existing wires", () => {
  const ports = new Map<string, FlowPort[]>([
    ["source", [
      { id: "name", label: "name", direction: "out", required: false, schema: { type: "string" } },
      { id: "count", label: "count", direction: "out", required: false, schema: { type: "number" } },
      { id: "ignored", label: "ignored", direction: "out", required: false, schema: { type: "string" } },
    ]],
    ["target", [
      { id: "name", label: "name", direction: "in", required: true, schema: { type: "string" } },
      { id: "count", label: "count", direction: "in", required: false, schema: { type: "string" } },
      { id: "other", label: "other", direction: "in", required: false, schema: { type: "string" } },
    ]],
  ]);
  const connections = matchingConnections("source", "target", ports, [
    { id: "e1", source: "source", sourceHandle: "name", target: "target", targetHandle: "name" },
  ]);
  assert.deepEqual(connections, [], "an already wired field is not duplicated");

  const fresh = matchingConnections("source", "target", ports, []);
  assert.deepEqual(fresh, [
    { source: "source", sourceHandle: "name", target: "target", targetHandle: "name" },
  ], "same label and compatible schema are connected; incompatible and unmatched fields are not guessed");
});

test("deleting a row deletes its wires rather than stranding them", () => {
  const next = dropEdgesForGonePorts([wire("e1", "in1", "p_a"), wire("e2", "in1", "p_b")], "in1", ["p_a", "p_b"], ["p_b"]);
  assert.deepEqual(next.map((e) => e.id), ["e2"], "a wire on a port that is gone has nowhere to be drawn");
});

test("only this node's wires are touched, even when another node has a port of the same id", () => {
  const edges = [wire("e1", "in1", "p_a"), wire("e2", "other", "p_a")];
  assert.deepEqual(dropEdgesForGonePorts(edges, "in1", ["p_a"], []).map((e) => e.id), ["e2"]);
});

test("adding a row leaves every wire alone, and hands the same array back", () => {
  const edges = [wire("e1", "in1", "p_a")];
  assert.equal(dropEdgesForGonePorts(edges, "in1", ["p_a"], ["p_a", "p_new"]), edges, "the same array, so React skips the update");
  assert.equal(dropEdgesForGonePorts(edges, "in1", ["p_a"], ["p_a"]), edges);
});

test("the two directions of the 注册表 ↔ 就地定义 switch are not symmetric", () => {
  const edges = [wire("e1", "in1", "p_a")];
  // Away from 就地定义: the inline ports are gone, so their wires must go.
  assert.deepEqual(dropEdgesForGonePorts(edges, "in1", ["p_a"], []), []);
  // Towards it: `before` is empty because the ports were coming from the cited
  // schema, and reading that as "nothing existed" must not cost the wires on
  // them. Seeding writes ids for the seeded rows; nothing here is dropped.
  assert.equal(dropEdgesForGonePorts(edges, "in1", [], ["p_x"]), edges);
});

// ── one implementation, not two ─────────────────────────────────────────────

/** The whole frontend tree minus this module — `books.test.ts`'s shape, for its
 *  reason. The copy this scan replaced sat in `FlowEditor.tsx` under a comment
 *  promising it mirrored `resolvePortsClient`'s, and the two fed different
 *  things: the canvas handles and the trigger dialog's parameter list. A
 *  divergence would have shown as a dialog asking for fields the handles said
 *  did not exist, with no typecheck able to see it. */
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOME = fileURLToPath(new URL("./flow-ports-client.ts", import.meta.url));
const VERSION_SORT = "b.version - a.version";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

test("the registry lookup has exactly one implementation in the browser", () => {
  // Test files are excluded from the sweep: this one holds the very snippet
  // it searches for, as the constant above, and would report itself as the
  // duplicate it exists to forbid.
  const offenders = sourceFiles(SRC_ROOT).filter((f) => f !== HOME && readFileSync(f, "utf8").includes(VERSION_SORT));
  assert.deepEqual(offenders, [], "a second 'newest matching version' is a second thing to drift");
});
