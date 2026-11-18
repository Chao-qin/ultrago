import { isUnconstrainedSchema, uncheckedNotice, unenforcedSchemaKeywords } from "./schema-keywords.js";
import { validateRecordData } from "./schema-records.js";
import type { SchemaCitationInput } from "./schema-citation.js";

export type ParamPrimitive = string | number | boolean;
export type ParamDefaultValue = ParamPrimitive | ParamDefaultValue[] | { [key: string]: ParamDefaultValue };
export type DefaultTemplate = string;
export type ParamMap = Record<string, unknown>;

export interface ParamSchemaFragment {
  type?: string;
  enum?: unknown[];
  default?: ParamDefaultValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
}

/** The one runtime contract shared by books, console forms and MCP inputs. */
export interface ParamSpec {
  name: string;
  /**
   * A flow parameter's STABLE port id — the handle a wire on the canvas
   * remembers, held apart from `name` so renaming the parameter cannot reach
   * the wire. See `flowInputPortId`.
   *
   * Only a flowInput node's own parameters carry one. A book's params are
   * declared by the book and are not renamable from a flow, so they have no use
   * for it, and absence is also what every graph written before this existed
   * looks like — hence the fallback rather than a required field.
   */
  portId?: string;
  required: boolean;
  description?: string;
  default?: ParamDefaultValue;
  defaultTemplate?: DefaultTemplate;
  schema?: ParamSchemaFragment;
  /** Reusable registry schema. Mutually exclusive with `schema`. */
  schemaRef?: SchemaCitationInput;
}

export type ParamSchemaResolver = (ref: SchemaCitationInput) => ParamSchemaFragment | null | undefined;

export type ResolvedParamSchemaStatus = "resolved" | "inline" | "unconstrained" | "missing" | "invalid" | "conflict";

export interface ResolvedParamSchema {
  status: ResolvedParamSchemaStatus;
  schema: ParamSchemaFragment | null;
  schemaRef?: SchemaCitationInput;
  message?: string;
}

/** Resolve one field's schema with one priority rule used by ports and runtime.
 * A missing citation intentionally returns `schema: null`, never `{}`. */
export function resolveParamSchema(spec: ParamSpec, resolveCitation?: ParamSchemaResolver): ResolvedParamSchema {
  if (spec.schema !== undefined && spec.schemaRef !== undefined) {
    return { status: "conflict", schema: null, schemaRef: spec.schemaRef, message: `param "${spec.name}" cannot declare both schema and schemaRef` };
  }
  if (spec.schemaRef !== undefined) {
    const ref = spec.schemaRef;
    if (!ref.name.trim() || (ref.version !== undefined && (!Number.isInteger(ref.version) || ref.version < 1))) {
      return { status: "invalid", schema: null, schemaRef: ref, message: `param "${spec.name}" has an invalid schemaRef` };
    }
    if (!resolveCitation) return { status: "missing", schema: null, schemaRef: ref, message: `param "${spec.name}" schemaRef ${ref.name}@${ref.version} cannot be resolved` };
    let schema: ParamSchemaFragment | null | undefined;
    try { schema = resolveCitation(ref); } catch { schema = null; }
    if (!schema) return { status: "missing", schema: null, schemaRef: ref, message: `param "${spec.name}" schemaRef ${ref.name}@${ref.version} was not found` };
    return { status: "resolved", schema, schemaRef: ref };
  }
  if (spec.schema !== undefined) return { status: "inline", schema: spec.schema };
  return { status: "unconstrained", schema: {} };
}

export interface DefaultContext {
  bookName: string;
  runId: string;
  planId: string;
  uuid: string;
  timezone?: string;
  now?: Date;
}

const TEMPLATE_TOKEN = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;
const ANY_TEMPLATE = /\{\{[^}]*\}\}/;
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001F\u007F/\\:*?"<>|\u2028\u2029]/u;
const TEMPLATE_VARIABLES = new Set(["bookName", "date", "time", "datetime", "timestamp", "runId", "planId", "uuid"]);

export function isParamMap(value: unknown): value is ParamMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function resolveParamDefaults(
  schema: ParamSpec[] | undefined,
  actual: ParamMap,
  context?: DefaultContext,
  resolveCitation?: ParamSchemaResolver,
): ParamMap {
  assertParamMap(actual);
  const out = { ...actual };
  for (const spec of schema ?? []) {
    assertDefaultDeclaration(spec, resolveCitation);
    const resolvedSchema = resolveParamSchema(spec, resolveCitation).schema ?? {};
    if (isProvided(out[spec.name])) {
      out[spec.name] = applyNestedDefaults(resolvedSchema, out[spec.name]);
      continue;
    }
    if (spec.default !== undefined) out[spec.name] = applyNestedDefaults(resolvedSchema, cloneDefault(spec.default));
    else {
      const schemaDefault = defaultFromSchema(resolvedSchema);
      if (schemaDefault !== NO_SCHEMA_DEFAULT) out[spec.name] = schemaDefault;
      else if (spec.defaultTemplate !== undefined && context) out[spec.name] = renderDefaultTemplate(spec.defaultTemplate, context);
    }
  }
  return out;
}

const NO_SCHEMA_DEFAULT = Symbol('no-schema-default');

function defaultFromSchema(schema: ParamSchemaFragment): unknown | typeof NO_SCHEMA_DEFAULT {
  if (schema.default !== undefined) return applyNestedDefaults(schema, cloneDefault(schema.default));
  if (schema.type !== 'object' || !isParamMap(schema.properties)) return NO_SCHEMA_DEFAULT;
  const nested = applyNestedDefaults(schema, {});
  return isParamMap(nested) && Object.keys(nested).length > 0 ? nested : NO_SCHEMA_DEFAULT;
}

function applyNestedDefaults(schema: ParamSchemaFragment, value: unknown): unknown {
  if (schema.type !== 'object' || !isParamMap(schema.properties) || !isParamMap(value)) return value;
  const next: ParamMap = { ...value };
  for (const [name, rawChildSchema] of Object.entries(schema.properties)) {
    if (!isParamMap(rawChildSchema)) continue;
    const childSchema = rawChildSchema as ParamSchemaFragment;
    if (isProvided(next[name])) {
      next[name] = applyNestedDefaults(childSchema, next[name]);
      continue;
    }
    const childDefault = defaultFromSchema(childSchema);
    if (childDefault !== NO_SCHEMA_DEFAULT) next[name] = childDefault;
  }
  return next;
}

function cloneDefault<T extends ParamDefaultValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneDefault(item)) as T;
  if (isParamMap(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDefault(item as ParamDefaultValue)])) as T;
  }
  return value;
}

export function normalizeParams(schema: ParamSpec[] | undefined, values: ParamMap, resolveCitation?: ParamSchemaResolver): ParamMap {
  assertParamMap(values);
  const byName = new Map((schema ?? []).map((spec) => [spec.name, spec]));
  const out: ParamMap = {};
  for (const [name, value] of Object.entries(values)) {
    const spec = byName.get(name);
    out[name] = spec ? parseParamValue(spec, value, resolveCitation) : value;
  }
  return out;
}

export function validateParams(schema: ParamSpec[] | undefined, values: ParamMap, resolveCitation?: ParamSchemaResolver): string[] {
  assertParamMap(values);
  const problems: string[] = [];
  const declared = new Map((schema ?? []).map((spec) => [spec.name, spec]));
  for (const spec of schema ?? []) {
    const value = values[spec.name];
    try {
      assertDefaultDeclaration(spec, resolveCitation);
      if (spec.defaultTemplate !== undefined) validateTemplateSyntax(spec.defaultTemplate);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    if (spec.required && !isProvided(value) && !hasDefault(spec)) {
      problems.push(`missing required param "${spec.name}"`);
      continue;
    }
    if (!isProvided(value)) continue;
    if (typeof value === "string" && ANY_TEMPLATE.test(value)) {
      problems.push(`param "${spec.name}" contains an unresolved template reference`);
      continue;
    }
    const resolved = resolveParamSchema(spec, resolveCitation);
    if (resolved.status === "missing" || resolved.status === "invalid" || resolved.status === "conflict") {
      problems.push(resolved.message ?? `param "${spec.name}" has an unresolved schema`);
      continue;
    }
    problems.push(...validateSchemaValue(value, resolved.schema ?? {}, `param "${spec.name}"`));
  }
  for (const name of Object.keys(values)) if (!declared.has(name)) problems.push(`unknown param "${name}" (not declared by this playbook)`);
  return problems;
}

/** Check a book's produced data against its declared `outputSchema`.
 *
 *  The mirror image of validateParams: params are the contract a caller must
 *  satisfy going IN, outputSchema is the contract the book promises coming OUT.
 *  Same recursive checker backs both, so a downstream consumer can be validated
 *  against an upstream producer's declaration without a second dialect.
 *
 *  No schema = no contract (a book whose run record IS the product), which is
 *  reported as zero problems rather than as a failure.
 *
 *  An empty result means "checked, and conforming" — nothing weaker. When the
 *  The engine is ajv — the same instance configuration `schema-records.ts`
 *  already used for the records API, so this repo has one JSON Schema
 *  implementation rather than two that drift.
 *
 *  It was a hand-written subset until it wasn't, and the subset's cost was
 *  concrete: `canonical-product`, the contract this whole pipeline exists to
 *  produce, keeps its constraints behind nine `$ref`s. Every one of them was
 *  invisible to the old validator, so a flow node emitting a malformed product
 *  was told its output "was NOT verified against those constraints" and allowed
 *  through. Now it is verified.
 *
 *  The notice did NOT go away, because ajv under `strict: false` is silent
 *  about keywords it does not know — `format` without the plugin, vendor
 *  `x-doudian-*` extensions — and silence is the failure this was built to
 *  prevent. It just fires for far less: see `unenforcedSchemaKeywords`. */
export function validateOutput(schema: ParamSchemaFragment | undefined | null, value: unknown): string[] {
  if (!schema || !isParamMap(schema) || isUnconstrainedSchema(schema)) return [];
  const result = validateRecordData(schema as Record<string, unknown>, value);
  const problems = result.ok ? [] : [...(result.errors ?? [])];
  // The notice survives the engine change, on a much narrower basis. It used to
  // fire for `$ref`, `const` and `minItems` — all of which are now genuinely
  // checked — and now fires only for what ajv really does pass over.
  const unenforced = unenforcedSchemaKeywords(schema);
  if (unenforced.length > 0) problems.push(uncheckedNotice(unenforced));
  return problems;
}

function validateSchemaValue(value: unknown, schema: ParamSchemaFragment, path: string): string[] {
  const problems: string[] = [];
  const type = schema.type;
  if (type === "string" && typeof value !== "string") return [`${path} must be string`];
  if ((type === "number" || type === "integer") && (typeof value !== "number" || !Number.isFinite(value))) return [`${path} must be a number`];
  if (type === "integer" && typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) problems.push(`${path} must be an integer`);
  if (type === "boolean" && typeof value !== "boolean") return [`${path} must be boolean`];
  if (type === "array" && !Array.isArray(value)) return [`${path} must be array`];
  if (type === "object" && !isParamMap(value)) return [`${path} must be object`];

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) problems.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) problems.push(`${path} length must be >= ${schema.minLength}`);
  if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) problems.push(`${path} length must be <= ${schema.maxLength}`);
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) problems.push(`${path} must be >= ${schema.minimum}`);
  if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) problems.push(`${path} must be <= ${schema.maximum}`);
  if (typeof value === "string" && typeof schema.pattern === "string") {
    try { if (!new RegExp(schema.pattern).test(value)) problems.push(`${path} does not match pattern ${schema.pattern}`); } catch { /* invalid schema pattern is ignored */ }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateSchemaValue(value, asSchema(branch), path).length === 0);
    if (matches.length !== 1) problems.push(`${path} must match exactly one allowed shape`);
  }
  if (schema.not && validateSchemaValue(value, asSchema(schema.not), path).length === 0) problems.push(`${path} matches a forbidden shape`);

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) problems.push(...validateSchemaValue(value[i], asSchema(schema.items), `${path}[${i}]`));
  }
  if (isParamMap(value)) {
    const properties = isParamMap(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) {
      // JSON Schema `required` means the property must exist. An empty string
      // is still a valid value unless the property's own schema rejects it via
      // minLength/pattern/etc.; replacement rules use this to mean deletion.
      const child = asSchema(properties[key]);
      const missing = value[key] === undefined || value[key] === null
        || (value[key] === "" && child.type !== "string");
      if (missing) problems.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) problems.push(`${path}.${key} is not allowed`);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (isProvided(value[key])) problems.push(...validateSchemaValue(value[key], asSchema(childSchema), `${path}.${key}`));
    }
  }
  return problems;
}

function asSchema(value: unknown): ParamSchemaFragment {
  return isParamMap(value) ? value as ParamSchemaFragment : {};
}

/** A param that carries FILE attachments: an array whose items accept a file
 * source (`url` or `localPath`) — the UploadSource contract the backend
 * resolves into bytes. The console renders these with a real file picker
 * instead of a JSON textarea. */
export interface AttachmentParamShape {
  /** Values the item's `type` discriminator allows (e.g. image/file), or null
   * when the item declares no discriminator — then no `type` is emitted. */
  kinds: string[] | null;
}

/** Read a param's schema as an attachment list, or null when it isn't one. */
export function attachmentParamShape(spec: ParamSpec, resolveCitation?: ParamSchemaResolver): AttachmentParamShape | null {
  const schema = resolveParamSchema(spec, resolveCitation).schema;
  if (schema?.type !== "array") return null;
  const items = asSchema(schema.items);
  if (!isParamMap(items.properties)) return null;
  if (!("url" in items.properties) || !("localPath" in items.properties)) return null;
  const declared = asSchema(items.properties.type).enum;
  const kinds = Array.isArray(declared) ? declared.filter((k): k is string => typeof k === "string") : [];
  return { kinds: kinds.length > 0 ? kinds : null };
}

export function parseParamValue(spec: ParamSpec, value: unknown, resolveCitation?: ParamSchemaResolver): unknown {
  if (value === undefined || value === null || value === "") return value;
  const type = resolveParamSchema(spec, resolveCitation).schema?.type;
  if (type === "number" || type === "integer") {
    if (typeof value === "number") return value;
    if (typeof value === "string") return value.trim() === "" ? value : Number(value.trim());
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    // Preserve invalid input so validateParams reports it as invalid instead
    // of silently turning every non-empty string into false.
    return value;
  }
  return value;
}

export function renderDefaultTemplate(template: string, context: DefaultContext): string {
  validateTemplateSyntax(template);
  const now = context.now ?? new Date();
  const parts = formatDate(now, context.timezone);
  const values: Record<string, string> = {
    bookName: context.bookName,
    runId: context.runId,
    planId: context.planId,
    uuid: context.uuid,
    timestamp: String(now.getTime()),
    ...parts,
  };
  const rendered = template.replace(TEMPLATE_TOKEN, (_, name: string) => values[name]);
  if (!isSafeFilename(rendered) || rendered === "." || rendered === "..") throw new Error(`defaultTemplate rendered an unsafe filename: ${rendered}`);
  return rendered;
}

function isProvided(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function hasDefault(spec: ParamSpec): boolean {
  return spec.default !== undefined || spec.schema?.default !== undefined || spec.defaultTemplate !== undefined;
}

function assertDefaultDeclaration(spec: ParamSpec, resolveCitation?: ParamSchemaResolver): void {
  if (spec.defaultTemplate !== undefined && (spec.default !== undefined || resolveParamSchema(spec, resolveCitation).schema?.default !== undefined)) {
    throw new Error(`param "${spec.name}" cannot declare both static default and defaultTemplate`);
  }
}

function validateTemplateSyntax(template: string): void {
  if (!hasSafeFilenameChars(template.replace(TEMPLATE_TOKEN, ""))) {
    throw new Error(`defaultTemplate contains unsafe filename characters: ${template}`);
  }
  const tokens = [...template.matchAll(TEMPLATE_TOKEN)];
  const withoutTokens = template.replace(TEMPLATE_TOKEN, "");
  if (withoutTokens.includes("{") || withoutTokens.includes("}")) {
    throw new Error(`defaultTemplate contains malformed template syntax: ${template}`);
  }
  for (const [, name] of tokens) {
    if (!TEMPLATE_VARIABLES.has(name)) throw new Error(`unknown defaultTemplate variable "${name}"`);
  }
}

function assertParamMap(value: ParamMap): void {
  if (!isParamMap(value)) throw new Error("params must be a plain object map");
}

function isSafeFilename(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && hasSafeFilenameChars(value);
}

function hasSafeFilenameChars(value: string): boolean {
  return !UNSAFE_FILENAME_CHARS.test(value);
}

function formatDate(date: Date, timezone?: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const datePart = `${values.year}-${values.month}-${values.day}`;
  const timePart = `${values.hour}-${values.minute}-${values.second}`;
  return { date: datePart, time: timePart, datetime: `${datePart}-${timePart}` };
}
