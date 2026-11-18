import { Button, Form, Input, InputNumber, Popover, Spin, Switch, Tooltip, Typography } from "antd";
import { DatabaseOutlined, DeleteOutlined, PlusOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import type { FormRule } from "antd";
import type { SchemaCitationInput } from "@bcp/shared";
import type { DefaultOptionType } from "antd/es/select";
import type { ParamSchema } from "../lib/types";
import type { AttachmentParamShape, ParamSchemaFragment } from "@bcp/shared";
import { attachmentParamShape, resolveParamDefaults, resolveParamSchema, validateParams } from "@bcp/shared";
import { AttachmentField } from "./AttachmentField";
import { BcpSelect } from "./BcpSelect";
import { EnumValueInput, JsonValueInput } from './typed-value-input';
import { api } from "../lib/api";
import { useSchemaResolver } from "../lib/use-schema-resolver";
import type { SchemaRecordRow } from "../lib/types";
import {
  filterSchemaRecordRows,
  parseRecordData,
  recordOptionLabel,
  recordVerdict,
} from "../lib/schema-record-options";

/**
 * ParamForm — schema-driven renderer for a book's declared input params,
 * shared by the manual-trigger dialog and the schedule dialog so both get the
 * SAME controls, validation, and default-filling (no more hand-typed JSON).
 *
 * SSOT: a playbook's `params` array (name/required/description/default/schema).
 * `default` is first-class at the TOP level (see BookParamSchema), falling back
 * to a JSON-Schema `schema.default` for back-compat.
 */

/** JSON Schema keywords we understand. Anything else is accepted but ignored. */
interface JsSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  description?: string;
  properties?: Record<string, JsSchema>;
  required?: string[];
  items?: JsSchema;
  [key: string]: unknown;
}

function asJsSchema(s: unknown): JsSchema {
  return (s ?? {}) as JsSchema;
}

/** Map a camelCase param name to display text ("reportFile" → "Report File"). */
function labelFor(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build antd Form rules from a param's JSON Schema (mirrors the backend's
 * validatePlaybookParams so the console path rejects the same bad values). */
function rulesFor(p: ParamSchema[number], resolver?: (ref: { name: string; version?: number }) => ParamSchemaFragment | null): FormRule[] {
  return [{
    validator: async (_, value) => {
      const type = asJsSchema(p.schema).type;
      if ((type === "array" || type === "object") && typeof value === "string" && value.trim()) {
        throw new Error("must be valid JSON");
      }
       const errors = validateParams([p], { [p.name]: value }, resolver);
      if (errors.length) throw new Error(errors[0].replace(`param "${p.name}" `, ""));
    },
  }];
}

/** The per-field control, chosen from schema.introspection (attachment list →
 * file picker, enum → Select, boolean → Switch, number → InputNumber, else
 * Input). */
function controlFor(p: ParamSchema[number], attachment: AttachmentParamShape | null, schema: JsSchema) {
  if (attachment) return <AttachmentField shape={attachment} />;
  const s = schema;
  const type = s.type ?? "string";
  const rawDefault = p.default ?? s.default;
  const placeholder = rawDefault !== undefined
    ? (typeof rawDefault === "string" ? rawDefault : JSON.stringify(rawDefault))
    : p.description;

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return <EnumValueInput options={s.enum} />;
  }
  if (type === "boolean") return <Switch />;
  if (type === "number" || type === "integer") {
    return <InputNumber style={{ width: "100%" }} placeholder={placeholder} min={s.minimum} max={s.maximum} step={1} />;
  }
  if (type === "array" || type === "object") {
    return <JsonValueInput expected={type === 'object' ? 'object' : 'any'} height={144} placeholder={placeholder ?? (type === "array" ? "[]" : "{}")} />;
  }
  return <Input.TextArea autoSize={{ minRows: 1, maxRows: 8 }} placeholder={placeholder} maxLength={s.maxLength} showCount={s.maxLength !== undefined} />;
}

type SchemaResolver = (ref?: { name: string; version?: number }) => ParamSchemaFragment | null;

function schemaRefOf(schema: JsSchema): { name: string; version?: number } | undefined {
  const ref = schema["x-bcp-schema-ref"];
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || typeof (ref as { name?: unknown }).name !== "string") return undefined;
  const version = (ref as { version?: unknown }).version;
  return typeof version === "number" ? { name: (ref as { name: string }).name, version } : { name: (ref as { name: string }).name };
}

function localRefSchema(schema: JsSchema, root: JsSchema): JsSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let target: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!target || typeof target !== "object") return schema;
    target = (target as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) return schema;
  const { $ref: _ref, ...local } = schema;
  return { ...(target as JsSchema), ...local };
}

function resolvedSchema(schema: JsSchema, resolver?: SchemaResolver, root = schema): JsSchema {
  schema = localRefSchema(schema, root);
  const ref = schemaRefOf(schema);
  const resolved = ref ? resolver?.(ref) : null;
  return resolved ? { ...(resolved as JsSchema), description: schema.description ?? (resolved as JsSchema).description } : schema;
}

/** Defaults are structural: an object gets defaults for its children, while an
 * array starts empty unless its schema explicitly supplies a default. */
export function schemaDefault(schemaInput: unknown, resolver?: SchemaResolver): unknown {
  return schemaDefaultFromRoot(schemaInput, resolver, asJsSchema(schemaInput));
}

function schemaDefaultFromRoot(schemaInput: unknown, resolver: SchemaResolver | undefined, root: JsSchema): unknown {
  const schema = resolvedSchema(asJsSchema(schemaInput), resolver, root);
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "object" && schema.properties) {
    const value: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      const childDefault = schemaDefaultFromRoot(child, resolver, root);
      if (childDefault !== undefined) value[key] = childDefault;
    }
    return value;
  }
  if (schema.type === "array") return [];
  return undefined;
}

function schemaRules(schema: JsSchema, required: boolean): FormRule[] {
  const rules: FormRule[] = [];
  if (required) rules.push({ required: true, message: "此字段必填" });
  if (schema.type === "string") {
    if (schema.minLength !== undefined) rules.push({ min: schema.minLength, message: `至少 ${schema.minLength} 个字符` });
    if (schema.maxLength !== undefined) rules.push({ max: schema.maxLength, message: `最多 ${schema.maxLength} 个字符` });
  }
  return rules;
}

function SchemaFieldLabel({ label, description, required }: { label?: string; description?: string; required?: boolean }) {
  if (!label) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {label}
      {description ? <Tooltip title={description}><QuestionCircleOutlined style={{ color: "var(--c-ink-3)", fontSize: 13 }} /></Tooltip> : null}
      {required ? <Typography.Text type="danger">*</Typography.Text> : null}
    </span>
  );
}

/** Recursive JSON Schema renderer shared by playbook params and SchemaRecord
 * editing. Object and array nodes intentionally stay structured instead of
 * falling back to an opaque JSON textarea. */
export function SchemaField({
  schema: schemaInput,
  name,
  label,
  required = false,
  schemaResolver,
  rootSchema,
  readOnly = false,
}: {
  schema: unknown;
  name: (string | number)[];
  label?: string;
  required?: boolean;
  schemaResolver?: SchemaResolver;
  rootSchema?: JsSchema;
  readOnly?: boolean;
}): JSX.Element {
  const autoResolver = useSchemaResolver();
  const resolver = schemaResolver ?? autoResolver;
  const root = rootSchema ?? asJsSchema(schemaInput);
  const schema = resolvedSchema(asJsSchema(schemaInput), resolver, root);
  const type = schema.type;
  const description = schema.description;

  if (type === "object" && schema.properties) {
    const requiredChildren = new Set(schema.required ?? []);
    return (
      <div style={{ borderLeft: "2px solid var(--c-border)", paddingLeft: 14, marginBottom: 16 }}>
        <Typography.Text strong={!!label}><SchemaFieldLabel label={label} description={description} required={required} /></Typography.Text>
        {Object.entries(schema.properties).map(([key, child]) => (
          <SchemaField
            key={key}
            schema={child}
            name={[...name, key]}
            label={key}
            required={requiredChildren.has(key)}
            schemaResolver={resolver}
            rootSchema={root}
            readOnly={readOnly}
          />
        ))}
      </div>
    );
  }

  if (type === "array") {
    const itemSchema = schema.items ?? {};
    return (
      <div style={{ borderLeft: "2px solid var(--c-border)", paddingLeft: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Typography.Text strong><SchemaFieldLabel label={label} description={description} required={required} /></Typography.Text>
        </div>
        <Form.List name={name}>
          {(fields, { add, remove }) => (
            <>
              {!readOnly ? <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => add(schemaDefaultFromRoot(itemSchema, resolver, root))} style={{ marginBottom: 8 }}>新增一项</Button> : null}
              {fields.map((field, index) => (
                <div key={field.key} style={{ borderTop: "1px solid var(--c-border)", paddingTop: 10, marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Typography.Text type="secondary">第 {index + 1} 项</Typography.Text>
                    {!readOnly ? <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => remove(field.name)} title="删除此项" /> : null}
                  </div>
                  <SchemaField schema={itemSchema} name={[...name, field.name]} schemaResolver={resolver} rootSchema={root} readOnly={readOnly} />
                </div>
              ))}
            </>
          )}
        </Form.List>
      </div>
    );
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  const valuePropName = type === "boolean" && !enumValues?.length ? "checked" : "value";
  const control = enumValues?.length
    ? <EnumValueInput options={enumValues} />
    : type === "boolean"
      ? <Switch disabled={readOnly} />
      : type === "number" || type === "integer"
        ? <InputNumber style={{ width: "100%" }} min={schema.minimum} max={schema.maximum} step={type === "integer" ? 1 : 0.01} disabled={readOnly} />
        : <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} maxLength={schema.maxLength} showCount={schema.maxLength !== undefined} disabled={readOnly} />;
  return (
    <Form.Item name={name} label={<SchemaFieldLabel label={label} description={description} required={required} />} required={false} rules={schemaRules(schema, required)} valuePropName={valuePropName}>
      {control}
    </Form.Item>
  );
}

/** The payload head shown in a picker option's tooltip: enough JSON to tell
 *  two same-shaped archives apart (an id + timestamp label cannot), short
 *  enough to stay a tooltip. */
function recordTooltip(row: SchemaRecordRow): string {
  const verdict =
    recordVerdict(row) === "ok"
      ? "✓ 存档时通过 schema 校验"
      : recordVerdict(row) === "violated"
        ? "⚠ 存档时违反 schema（仍可选，提交时会再校验）"
        : "未校验";
  const head = row.data && row.data.length > 300 ? `${row.data.slice(0, 300)}…` : (row.data ?? "（无载荷）");
  return `${verdict}\n${row.bytes}B · ${row.createdAt}\n\n${head}`;
}

type PickerOption = { value: string; search: string; label: JSX.Element };
type PickerOptGroup = { label: string; options: PickerOption[] };
// antd's grouped/flat options share DefaultOptionType (extra keys allowed);
// the union above is only for the builder's internal type safety.
type PickerOptions = DefaultOptionType[];

/**
 * The record picker lives NEXT TO the form label, not above the textarea.
 *
 * Two modes:
 * - **citation given** — the param's schemaRef names a schema: only that
 *   schema's archives are listed.
 * - **no citation** — any object/array param without a schemaRef (e.g. a
 *   playbook whose 「product」 param obviously carries a canonical payload but
 *   never bothered to cite it) still gets the picker, listing every archived
 *   payload grouped by schema name. The playbook author should not have to
 *   have predicted that picking an archive would be wanted; the data exists,
 *   the form should offer it.
 *
 * The old layout rendered a full-width Select row on top of the JSON box for
 * every citation field — most fields never get filled from an archive, so the
 * row was paid on every render and pushed the actual form down a whole line.
 * A small 「选存档」 link at the right end of the label opens a Popover with
 * the same loader (lazy, on open) plus search and per-option tooltips showing
 * the payload.
 *
 * Picking writes through `form.setFieldValue` directly: the stored value IS
 * the parsed object. The old event-shaped `onChange({target:{value: parsed}})`
 * round-trip was also the [object Object] bug — `jsonValueFromEvent` does
 * `String(value)` first, so an object became the literal text "[object
 * Object]", the JSON.parse fell through, and that garbage got stored.
 */
function SchemaRecordPicker({
  citation,
  fieldPath,
}: {
  citation?: SchemaCitationInput;
  fieldPath: (string | number)[];
}): JSX.Element {
  const form = Form.useFormInstance();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SchemaRecordRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    if (rows || loading) return;
    setLoading(true);
    api
      .listSchemaRecords(citation ? { schemaName: citation.name } : {})
      .then((all) => setRows(filterSchemaRecordRows(all, citation)))
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  };

  const citationLabel = citation
    ? `${citation.name}${citation.version !== undefined ? `@${citation.version}` : ""}`
    : null;

  // Flat list under a citation; grouped by schema name for the whole-registry
  // mode so 4 archives from 3 schemas don't read as one undifferentiated pile.
  const options = useMemo<PickerOptions>(() => {
    const option = (row: SchemaRecordRow) => ({
      value: row.id,
      search: `${citationLabel ?? row.schemaName ?? ""} ${recordOptionLabel(row, citation)} ${row.id}`.toLowerCase(),
      label: (
        <Tooltip title={recordTooltip(row)} mouseEnterDelay={0.35} placement="left">
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>
            {recordOptionLabel(row, citation)}
          </span>
        </Tooltip>
      ),
    });
    if (citation) return (rows ?? []).map(option);
    const bySchema = new Map<string, SchemaRecordRow[]>();
    for (const row of rows ?? []) {
      const name = row.schemaName ?? "（未登记 schema）";
      bySchema.set(name, [...(bySchema.get(name) ?? []), row]);
    }
    return [...bySchema.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rs]) => ({ label: name, options: rs.map(option) }));
  }, [rows, citation, citationLabel]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
      trigger="click"
      placement="bottom"
      destroyOnHidden
      content={
        <div style={{ width: 360 }}>
          <BcpSelect
            style={{ width: "100%" }}
            placeholder={citationLabel ? `搜索 ${citationLabel} 的存档…` : "搜索全部存档（按 schema 分组）…"}
            loading={loading}
            optionFilterProp="search"
            onSelect={(id: string) => {
              const row = rows?.find((r) => r.id === id);
              if (!row) return;
              const parsed = parseRecordData(row);
              // Stored directly as the parsed object — see the component
              // comment for why this bypasses the event round-trip.
              form.setFieldValue(fieldPath, parsed.ok ? parsed.value : row.data);
              setOpen(false);
            }}
            options={options}
            notFoundContent={
              loadError ?? (loading ? <Spin size="small" /> : "还没有任何 SchemaRecord 存档")
            }
          />
          {loadError ? (
            <Typography.Text type="danger" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
              SchemaRecord 加载失败：{loadError}
            </Typography.Text>
          ) : null}
        </div>
      }
    >
      <Button
        type="link"
        size="small"
        icon={<DatabaseOutlined />}
        title={citationLabel ? `从 ${citationLabel} 的 SchemaRecord 存档填入` : "从 SchemaRecord 存档填入"}
        style={{ padding: 0, height: 18, fontSize: 12 }}
        onClick={(e) => e.stopPropagation()}
      >
        选存档
      </Button>
    </Popover>
  );
}

/** The form initial values from a schema's defaults (top-level `default` first,
 * then `schema.default`). Used to pre-fill the form so an omitted param gets
 * the book's intended value. */
export function paramInitialValues(schema: ParamSchema, schemaResolver?: (ref: { name: string; version?: number }) => ParamSchemaFragment | null): Record<string, unknown> {
  // Dynamic defaults are intentionally omitted from the form. They are
  // resolved once by the execution boundary with real run/plan identities.
  return resolveParamDefaults(schema, {}, undefined, schemaResolver);
}

/** Render the form items for a schema. `namePrefix` nests the fields under a
 * path (e.g. `["params"]` so a form collects them as `values.params`).
 *
 * The resolver is resolved AUTOMATICALLY: callers pass nothing, the hook
 * fetches the registry once (shared `["schemas"]` cache) and citation params
 * light up the 选存档 picker on their own. The optional prop only exists for
 * FlowEditor, which already holds the list for its port typing. */
export function ParamFields({ schema, namePrefix = [], excludeNames = [], schemaResolver: schemaResolverProp }: { schema: ParamSchema; namePrefix?: (string | number)[]; excludeNames?: string[]; schemaResolver?: (ref: { name: string; version?: number }) => ParamSchemaFragment | null }) {
  const autoResolver = useSchemaResolver();
  const schemaResolver = schemaResolverProp ?? autoResolver;
  return (
    <>
      {schema.filter((p) => !excludeNames.includes(p.name)).map((p) => {
        const resolved = resolveParamSchema(p, schemaResolver).schema;
        const effective = resolved ? { ...p, schema: resolved } : p;
        const s = asJsSchema(effective.schema);
        // An attachment list is an array, but it is edited as files — not as
        // the JSON text the array/object branch below would ask for.
        const attachment = attachmentParamShape(effective);
        const json = !attachment && (s.type === "array" || s.type === "object");
        // A citation whose document RESOLVED upgrades the plain JSON textarea
        // to the record picker scoped to that schema. An object/array param
        // WITHOUT a citation gets the picker too, unscoped: the playbook
        // author shouldn't have to have cited a schema for the form to offer
        // the archived data (see SchemaRecordPicker's no-citation mode). An
        // unresolved citation degrades the label to the whole registry rather
        // than hiding the picker — degrading the form because a lookup failed
        // would block a trigger the backend would happily validate.
        const citation =
          p.schemaRef !== undefined && json && resolved
            ? p.schemaRef
            : undefined;
        const withPicker = json;
        const desc = p.description ?? (s as JsSchema & { description?: string }).description;
        return (
          <Form.Item
            key={p.name}
            name={[...namePrefix, p.name]}
            label={
              withPicker ? (
                // 左右排布：【字段名 + ? tooltip】在左，「选存档」靠右。
                // label 行被 :has(.form-label-row) 撑成了整行 flex（见
                // index.css），antd 自带的 tooltip 图标会跟在整行末尾——
                // 所以这些字段的问号图标在这里手绘，紧跟字段名；
                // 其它字段仍走 Form.Item 的 tooltip。
                <span
                  className="form-label-row"
                  style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {labelFor(p.name)}
                    {desc && (
                      <Tooltip title={desc}>
                        <QuestionCircleOutlined style={{ color: "var(--c-ink-3)", fontSize: 13 }} />
                      </Tooltip>
                    )}
                  </span>
                  <SchemaRecordPicker citation={citation} fieldPath={[...namePrefix, p.name]} />
                </span>
              ) : (
                labelFor(p.name)
              )
            }
            tooltip={withPicker ? undefined : desc}
            required={p.required}
            rules={rulesFor(p, schemaResolver)}
            valuePropName={s.type === 'boolean' && !s.enum?.length ? 'checked' : 'value'}
          >
            {controlFor(effective, attachment, s)}
          </Form.Item>
        );
      })}
    </>
  );
}
