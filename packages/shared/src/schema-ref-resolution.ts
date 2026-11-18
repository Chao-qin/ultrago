import type { ParamSchemaFragment } from "./param-runtime.js";
import type { SchemaCitationInput } from "./schema-citation.js";

export type AsyncSchemaCitationResolver = (ref: SchemaCitationInput) => Promise<ParamSchemaFragment | null | undefined>;

/** Expand the console's field-level registry marker for runtime consumers.
 * Storage keeps `x-bcp-schema-ref`; validators receive ordinary JSON Schema. */
export async function resolveEmbeddedSchemaRefs(schema: ParamSchemaFragment, resolve: AsyncSchemaCitationResolver): Promise<ParamSchemaFragment> {
  const visit = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const rawRef = object["x-bcp-schema-ref"];
    if (rawRef && typeof rawRef === "object" && typeof (rawRef as { name?: unknown }).name === "string") {
      const resolved = await resolve(rawRef as SchemaCitationInput);
      if (!resolved) return value;
      const { ["x-bcp-schema-ref"]: _ref, ...annotations } = object;
      const expanded = await visit(resolved) as Record<string, unknown>;
      return { ...expanded, ...annotations };
    }
    const entries = await Promise.all(Object.entries(object).map(async ([key, child]) => [key, await visit(child)] as const));
    return Object.fromEntries(entries);
  };
  return await visit(schema) as ParamSchemaFragment;
}
