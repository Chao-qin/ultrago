import type { ParamSpec } from "./param-runtime.js";
import type { SchemaCitationInput } from "./schema-citation.js";

/** ParamSpec[] 里唯一没有 JSON Schema 对应物的字段，用扩展关键字承载。
 *  `x-` 前缀是未知关键字，ajv 在 strict:false 下忽略，不影响校验语义。 */
export const DEFAULT_TEMPLATE_KEYWORD = "x-bcp-default-template";
export const SCHEMA_REF_KEYWORD = "x-bcp-schema-ref";

export interface JsonSchemaDoc {
  $schema: string;
  title?: string;
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, Record<string, unknown>>;
}

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

export function paramSpecsToJsonSchema(specs: ParamSpec[], title?: string): JsonSchemaDoc {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const spec of specs) {
    const nested = spec.schema ?? {};
    if (spec.schemaRef !== undefined && spec.schema !== undefined) {
      throw new Error(`paramSpecsToJsonSchema: param "${spec.name}" cannot declare both schema and schemaRef`);
    }
    // `description`/`default` can live either on the ParamSpec itself or nested inside
    // spec.schema — both merge into the same JSON Schema property key, so a round trip
    // can no longer tell which side it came from. Rather than silently picking one (and
    // silently dropping or relocating the other — see param-schema-bridge.test.ts for the
    // two cases this used to lose data on), fail closed: refuse to convert and say exactly
    // which param and which key collided.
    if (Object.prototype.hasOwnProperty.call(nested, "description")) {
      throw new Error(
        `paramSpecsToJsonSchema: param "${spec.name}" has "description" nested inside spec.schema, which collides with the top-level JSON Schema "description" key — the round trip cannot tell them apart. Move it to spec.description (or spec.schema.description exclusively) instead of leaving both representations possible.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(nested, "default")) {
      throw new Error(
        `paramSpecsToJsonSchema: param "${spec.name}" has "default" nested inside spec.schema, which collides with the top-level JSON Schema "default" key — the round trip cannot tell them apart. Move it to spec.default (or spec.schema.default exclusively) instead of leaving both representations possible.`,
      );
    }
    const prop: Record<string, unknown> = { ...nested };
    if (spec.schemaRef !== undefined) prop[SCHEMA_REF_KEYWORD] = spec.schemaRef;
    if (spec.description !== undefined) prop.description = spec.description;
    if (spec.default !== undefined) prop.default = spec.default;
    if (spec.defaultTemplate !== undefined) prop[DEFAULT_TEMPLATE_KEYWORD] = spec.defaultTemplate;
    properties[spec.name] = prop;
    if (spec.required) required.push(spec.name);
  }
  return {
    $schema: DIALECT,
    ...(title ? { title } : {}),
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

/** One intentional, harmless normalization: an input `spec.schema: {}` (present but empty)
 *  comes back as `spec.schema` being absent (`undefined`) — not the same *object identity*,
 *  but the same *meaning*. Every consumer of ParamSpec reads the schema fragment through
 *  `spec.schema?.xxx` optional chaining (see `resolveParamDefaults` / `parseParamValue` /
 *  `attachmentParamShape` in param-runtime.ts), so `{}` and "missing" are indistinguishable
 *  to all of them. This is not data loss; it's dropping a distinction
 *  nothing downstream can observe. */
export function jsonSchemaToParamSpecs(doc: JsonSchemaDoc): ParamSpec[] {
  const required = new Set(doc.required ?? []);
  return Object.entries(doc.properties ?? {}).map(([name, raw]) => {
    const { description, default: def, [DEFAULT_TEMPLATE_KEYWORD]: tpl, [SCHEMA_REF_KEYWORD]: ref, ...schema } = raw;
    const spec: ParamSpec = { name, required: required.has(name) };
    if (description !== undefined) spec.description = description as string;
    if (def !== undefined) spec.default = def as ParamSpec["default"];
    if (tpl !== undefined) spec.defaultTemplate = tpl as ParamSpec["defaultTemplate"];
    if (ref !== undefined) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref) || typeof (ref as Record<string, unknown>).name !== "string" || ("version" in ref && !Number.isInteger((ref as Record<string, unknown>).version))) {
        throw new Error(`jsonSchemaToParamSpecs: param "${name}" has an invalid ${SCHEMA_REF_KEYWORD}`);
      }
      if (Object.keys(schema).length > 0) throw new Error(`jsonSchemaToParamSpecs: param "${name}" has both ${SCHEMA_REF_KEYWORD} and schema keywords`);
      spec.schemaRef = ref as SchemaCitationInput as ParamSpec["schemaRef"];
    }
    if (Object.keys(schema).length > 0) spec.schema = schema as ParamSpec["schema"];
    return spec;
  });
}
