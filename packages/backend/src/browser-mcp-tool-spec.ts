/**
 * Registration for every tool that maps 1:1 to an RpcMethod.
 *
 * The tool's name, description and per-parameter docs all come from
 * MCP_TOOL_INSTRUCTIONS (packages/shared/src/mcp-instructions.ts). This helper
 * attaches each documented param to its schema field and refuses to register a
 * tool whose schema and docs disagree — a field with no doc anywhere, or a doc
 * for a field the schema lacks. Both used to happen silently: agents saw
 * undocumented params, and a documented param (right_click's `text`) was
 * dropped before it reached the browser.
 */
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { MCP_TOOL_INSTRUCTIONS, type McpToolInstruction, type RpcMethod } from "@bcp/shared";

/** The instruction entry for a method that has a tool; throws for one that deliberately has none. */
export function toolSpecOf(method: RpcMethod): McpToolInstruction {
  const spec = (MCP_TOOL_INSTRUCTIONS as Record<RpcMethod, McpToolInstruction | null>)[method];
  if (!spec) throw new Error(`${method} has no MCP tool (MCP_TOOL_INSTRUCTIONS maps it to null)`);
  return spec;
}

/** Attach the documented descriptions to `shape`, failing on any mismatch. */
export function describedShape<S extends ZodRawShapeCompat>(method: RpcMethod, shape: S): S {
  const spec = toolSpecOf(method);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const doc = spec.params[key];
    const own = (field as { description?: string }).description;
    if (!doc && !own) throw new Error(`MCP tool ${spec.name}: param "${key}" has no description in MCP_TOOL_INSTRUCTIONS`);
    out[key] = doc ? (field as { describe(d: string): unknown }).describe(doc) : field;
  }
  for (const key of Object.keys(spec.params)) {
    if (!(key in shape)) throw new Error(`MCP tool ${spec.name}: "${key}" is documented but missing from its input schema`);
  }
  return out as S;
}

/** Register the tool for `method` under its documented name, description and annotations. */
export function registerRpcTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  method: RpcMethod,
  shape: S,
  cb: ToolCallback<S>,
): void {
  const spec = toolSpecOf(method);
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: describedShape(method, shape), annotations: spec.annotations },
    cb,
  );
}
