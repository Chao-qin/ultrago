import { test } from "node:test";
import assert from "node:assert/strict";
import type { ParamSchemaFragment } from "./param-runtime.js";
import { SCRIPT_LANGUAGES, buildScriptSource, schemaToTs, scriptSkeleton } from "./script-skeleton.js";

const PRODUCT: ParamSchemaFragment = {
  type: "object",
  properties: { title: { type: "string" }, price: { type: "number" }, tags: { type: "array", items: { type: "string" } } },
  required: ["title"],
};

test("a declared contract becomes a TS type, optional fields marked", () => {
  assert.equal(schemaToTs(PRODUCT), "{ title: string; price?: number; tags?: string[] }");
});

test("a contract the validator cannot check becomes `unknown`, never `string`", () => {
  // This is the bug the sibling generator in codegen.ts still has: its fallback
  // is `"string"`, so a document whose fields live behind a `$ref` compiles as
  // a string and nothing anywhere says otherwise. A type that claims more than
  // the runtime validator checks is a type that lies.
  const withRef: ParamSchemaFragment = {
    type: "object",
    properties: { images: { $ref: "#/$defs/image" } },
    $defs: { image: { type: "object", properties: { url: { type: "string" } } } },
  } as ParamSchemaFragment;
  assert.equal(schemaToTs(withRef), "unknown");
  // An untyped schema is undeclared, not a string either.
  assert.equal(schemaToTs({} as ParamSchemaFragment), "unknown");
  assert.equal(schemaToTs(null), "unknown");
});

test("an undeclared contract says so instead of inventing fields", () => {
  const { header } = scriptSkeleton("ts", null, null);
  assert.match(header, /入参契约未声明/);
});

test("inline bodies are TypeScript only, and the list says why in one place", () => {
  // Inline code is the one untrusted surface here — typed into a panel, run on
  // the operator's machine. Node's own `--permission` contains it identically
  // on all three platforms at no dependency cost; a spawned python3 holds the
  // console user's full rights with no cross-platform way to contain it.
  // Python did not go away: a `command` node still runs it, from a reviewed
  // file in the repo, which is a different trust class.
  assert.deepEqual([...SCRIPT_LANGUAGES], ["ts"]);
});

test("the ts skeleton types both ends and keeps the same stdout protocol", () => {
  const { header, footer } = scriptSkeleton("ts", PRODUCT, { type: "object", properties: { ok: { type: "boolean" } } });
  assert.match(header, /^type Params = \{ title: string; price\?: number; tags\?: string\[\] \};$/m);
  assert.match(header, /^type Result = \{ ok\?: boolean \};$/m);
  assert.match(header, /async function handler\(params: Params\): Promise<Result> \{/);
  assert.match(footer, /process\.stdout\.write\("\\n" \+ JSON\.stringify/);
});

test("a body is indented as a block, so its own nesting survives", () => {
  const source = buildScriptSource("ts", 'if (params.price! > 1) {\n  return { big: true };\n}\n\nreturn { big: false };', PRODUCT, null);
  assert.match(source, /\n  if \(params\.price! > 1\) \{\n/);
  assert.match(source, /\n    return \{ big: true \};\n/, "相对缩进整体平移,不被压平");
  // A blank line stays blank rather than becoming spaces — trailing whitespace
  // is noise in an editor and worse in a diff.
  assert.match(source, /\}\n\n  return \{ big: false \};/);
});

test("an empty body still produces a program that runs", () => {
  // Otherwise a node its author has not filled in yet fails with a parse error,
  // which reads as a broken script rather than an empty one.
  assert.match(buildScriptSource("ts", "   \n\n", null, null), /return \{\} as Result/);
});
