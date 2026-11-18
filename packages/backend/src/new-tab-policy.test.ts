import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOL_INSTRUCTIONS, RpcMethod } from "@bcp/shared";

test("new_tab exposes background-opening semantics", () => {
  const instructions = MCP_TOOL_INSTRUCTIONS[RpcMethod.NewTab];

  assert.equal(instructions.params.active, "Whether the new tab should become active; defaults to false.");
  assert.match(instructions.description, /opens in the background by default/);
});
