import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowGraph, FlowNode, ParamSchemaFragment } from "@bcp/shared";
import { deriveOutputSchema } from "./flows.service.js";

const REPLY: ParamSchemaFragment = { type: "object", properties: { reply: { type: "string" } } };

type SchemaRef = { name: string; version?: number };

function outputNode(id: string, label?: string, config: { schema?: ParamSchemaFragment; schemaRef?: SchemaRef } = {}): FlowNode {
  return {
    id,
    type: "flowOutput",
    position: { x: 0, y: 0 },
    ...(label === undefined ? {} : { label }),
    config,
  };
}

function graphOf(nodes: FlowNode[]): FlowGraph {
  return { nodes, edges: [] };
}

/** No node in these older tests cites a registry, so the resolver is never
 *  expected to be called with a real ref — asserting that pins the inline
 *  path down to exactly what it was before `deriveOutputSchema` learned to
 *  resolve refs at all. */
const neverResolve = async (ref: SchemaRef | undefined): Promise<ParamSchemaFragment | null> => {
  assert.equal(ref, undefined, "inline-only nodes must not ask the resolver for anything");
  return null;
};

/**
 * The shape must not depend on how many outputs there are.
 *
 * This is the regression that motivated the whole test: a lone flowOutput used
 * to yield its schema BARE, so `Flow.outputSchema` described `{reply: string}`
 * while `finishRun` produced `{产出: {reply: string}}` — and adding a second
 * output node rewrote the first one's contract behind the author's back.
 */
test("one flowOutput and two produce the same KIND of contract — an object keyed by node", async () => {
  const one = await deriveOutputSchema(graphOf([outputNode("o1", "产出", { schema: REPLY })]), neverResolve);
  const two = await deriveOutputSchema(
    graphOf([outputNode("o1", "产出", { schema: REPLY }), outputNode("o2", "次产出", { schema: REPLY })]),
    neverResolve,
  );

  assert.deepEqual(one, { type: "object", properties: { 产出: REPLY } });
  assert.deepEqual(two, { type: "object", properties: { 产出: REPLY, 次产出: REPLY } });

  // Said structurally as well as literally: whatever the node count, the
  // contract is an object, the node names are its keys, and each node's own
  // schema sits under its key rather than at the top level.
  for (const [count, derived] of [[1, one], [2, two]] as const) {
    assert.equal(derived?.type, "object", `${count} 个 flowOutput 也必须给出 object 形状`);
    const properties = derived?.properties as Record<string, ParamSchemaFragment>;
    assert.equal(Object.keys(properties).length, count);
    assert.deepEqual(properties["产出"], REPLY);
  }
  // And the one-node answer is NOT the node's schema itself.
  assert.notDeepEqual(one, REPLY);
});

/** The key rule is `label ?? id`, matching what `finishRun` writes when it
 *  collects the products — the two sides describing the same run must agree on
 *  the key, not merely on the nesting. */
test("an unlabelled node is keyed by its id, exactly as the runner keys it", async () => {
  assert.deepEqual(
    await deriveOutputSchema(graphOf([outputNode("flowOutput-9f2a", undefined, { schema: REPLY })]), neverResolve),
    { type: "object", properties: { "flowOutput-9f2a": REPLY } },
  );
});

/** A node that declares nothing still occupies a key: the run will produce a
 *  value there, and a contract that omitted it would describe a product the
 *  flow does not have. */
test("a node with no declared contract keeps its key, with an empty schema", async () => {
  assert.deepEqual(
    await deriveOutputSchema(graphOf([outputNode("o1", "产出"), outputNode("o2", "次产出", { schema: REPLY })]), neverResolve),
    { type: "object", properties: { 产出: {}, 次产出: REPLY } },
  );
  // Undeclared is not the same as absent: the lone node still produces a value
  // under its key, so the contract says so instead of collapsing to null.
  assert.deepEqual(await deriveOutputSchema(graphOf([outputNode("o1", "产出")]), neverResolve), {
    type: "object",
    properties: { 产出: {} },
  });
});

test("no flowOutput node means no contract at all, not an empty object", async () => {
  assert.equal(await deriveOutputSchema(graphOf([]), neverResolve), null);
  assert.equal(
    await deriveOutputSchema(
      graphOf([{ id: "b1", type: "book", position: { x: 0, y: 0 }, config: { bookId: "x" } }]),
      neverResolve,
    ),
    null,
  );
});

/**
 * The bug this file was added to close: a flowOutput declared via the
 * registry (`config.schemaRef`, no `config.schema`) used to be read by
 * `deriveOutputSchema` as if it declared nothing, so `Flow.outputSchema` came
 * out `{}` even though the canvas's port inspector showed a real contract.
 * `resolvePorts`/`portsFor` always resolved the ref; `deriveOutputSchema` is
 * the one that must now do the same.
 */
test("a ref-mode flowOutput's resolved schema lands in the derived contract, same as inline", async () => {
  const ref: SchemaRef = { name: "canonical-product", version: 1 };
  const resolveKnownRef = async (r: SchemaRef | undefined) => {
    assert.deepEqual(r, ref);
    return REPLY;
  };

  const derived = await deriveOutputSchema(graphOf([outputNode("o1", "产出", { schemaRef: ref })]), resolveKnownRef);

  assert.deepEqual(derived, { type: "object", properties: { 产出: REPLY } });
});

/**
 * Inline and ref are two spellings of "declare this output's contract" — the
 * FLOW-1 invariant says the console's two consumers of a flowOutput's config
 * (the port and the recorded Flow.outputSchema) must never disagree about
 * what a node declared. This asserts the second half of that: the two
 * SPELLINGS must also produce byte-identical structures once resolved, so
 * an author switching a node from inline to registry (or back) sees no
 * change in what gets recorded.
 */
test("inline mode and ref mode produce the same structure once the ref resolves to the same schema", async () => {
  const ref: SchemaRef = { name: "canonical-product", version: 1 };
  const resolveKnownRef = async () => REPLY;

  const inline = await deriveOutputSchema(graphOf([outputNode("o1", "产出", { schema: REPLY })]), neverResolve);
  const viaRef = await deriveOutputSchema(graphOf([outputNode("o1", "产出", { schemaRef: ref })]), resolveKnownRef);

  assert.deepEqual(inline, viaRef);
});

/**
 * The registry being empty, lagging, or unreachable must not block saving the
 * canvas — mirrors filesync's `resolveRef`, which also degrades to null
 * rather than throwing. `deriveOutputSchema` never calls the resolver in a
 * way that could reject in FlowsService (`resolveOutputSchemaRef` catches
 * internally via `schemaFor`), so this pins the CONTRACT: a resolver that
 * answers "unresolved" with null must not make the whole derivation throw,
 * and the node's key still gets an empty schema rather than being dropped.
 */
test("a schemaRef that fails to resolve degrades to an empty schema, not a thrown error", async () => {
  const resolveNothing = async () => null;

  const derived = await deriveOutputSchema(
    graphOf([outputNode("o1", "产出", { schemaRef: { name: "does-not-exist" } })]),
    resolveNothing,
  );

  assert.deepEqual(derived, { type: "object", properties: { 产出: {} } });
});
