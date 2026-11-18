/**
 * Everything that picks a schema, in one place.
 *
 * These used to live inline in FlowEditor.tsx, where the two selectors had
 * drifted apart: `SchemaRefSelect` and `FieldTypeSelect` each built the registry
 * option list with byte-identical filter/sort/label code, but only the latter
 * offered primitive types, and neither could express an array's element type
 * even though the engine models it end to end (`portTypeLabel` renders `X[]`,
 * `mapPorts` projects from `items`, `isAssignable` recurses into it). Sharing
 * `buildRegistryOptions` is what keeps them from drifting again.
 */
import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Form, Input, InputNumber, Modal, Space, Tag, Typography, message } from "antd";
import { EyeOutlined } from "@ant-design/icons";
import { api } from "../lib/api";
import { BcpSelect } from "./BcpSelect";
import { JsonEditor } from "./JsonEditorLazy";
import { SCHEMA_KINDS, SCHEMA_KIND_LABELS, checkSchemaContract } from "../lib/types";
import type { SchemaRow } from "../lib/types";
import { SCHEMA_REF_KEYWORD, type ParamSchemaFragment, type ParamSpec, type SchemaKind } from "@bcp/shared";

export const PARAM_TYPES = ["string", "number", "integer", "boolean", "object", "array"] as const;

/** A citation as text. `?` marks a ref that never carried a version. */
export function schemaCitationLabel(ref: { name: string; version?: number }): string {
  return `${ref.name}@${ref.version ?? "?"}`;
}

/** Resolve a citation against the registry. A version-less ref means "active". */
export function schemaForCitation(schemas: SchemaRow[], ref: { name: string; version?: number } | undefined): SchemaRow | undefined {
  if (!ref?.name) return undefined;
  return schemas.find((row) => row.name === ref.name && (ref.version === undefined ? row.active : row.version === ref.version) && !row.deletedAt);
}

export function schemaSummary(row: SchemaRow | undefined): string | undefined {
  if (!row) return undefined;
  try {
    const doc = JSON.parse(row.jsonSchema) as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    if (doc.type === "object" && doc.properties) return `${Object.keys(doc.properties).length} 个字段${doc.required?.length ? `，必填 ${doc.required.length} 个` : ""}`;
    return doc.type ? `type: ${doc.type}` : "未声明类型";
  } catch {
    return "Schema 文档无法解析";
  }
}

function prettySchema(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export interface RegistryOption {
  value: string;
  label: string;
  search: string;
  /** Property names, shown under the label so the dropdown answers "what is in
   *  this contract" without committing to it first. */
  fields?: string;
}

/**
 * The registry rows a selector may offer, as options.
 *
 * `keep` is the citation currently held by the field: a deactivated version
 * stays listed while it is the selected one, otherwise selecting it once would
 * make it unselectable forever after.
 */
export function buildRegistryOptions(schemas: SchemaRow[], keep?: string): RegistryOption[] {
  return schemas
    .filter((row) => !row.deletedAt && (row.active || keep === `${row.name}@${row.version}`))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.version < b.version ? 1 : a.version > b.version ? -1 : 0))
    .map((row) => ({
      value: `${row.name}@${row.version}`,
      label: `${row.name}@${row.version}${row.title ? ` · ${row.title}` : ""}${row.active ? "" : " · 已停用"}`,
      search: `${row.name} ${row.title ?? ""} ${row.description ?? ""} ${row.kind} ${row.entity ?? ""}`.toLowerCase(),
      // What is actually IN this schema, so the choice can be made from the open
      // dropdown. Reading a contract used to require selecting it first and then
      // opening the drawer (the eye button is `disabled={!selectedRow}`) — i.e.
      // committing to a citation in order to find out whether it was the right
      // one. A field list is what distinguishes two similarly-named entries.
      fields: fieldNamesSummary(row),
    }));
}

/** The first few property NAMES of a registry row, for the dropdown line.
 *
 *  Distinct from `schemaSummary`, which counts them ("5 个字段"): a count cannot
 *  tell two similarly-sized contracts apart, and telling them apart is the whole
 *  job of an option line. `jsonSchema` is stored as TEXT, and a row whose body
 *  will not parse must not take the dropdown down with it — an unreadable
 *  summary is a missing line, not an error. */
type SchemaBody = { properties?: Record<string, unknown>; type?: string };
function fieldNamesSummary(row: SchemaRow): string | undefined {
  let body: SchemaBody | null = null;
  try {
    body = JSON.parse(row.jsonSchema) as SchemaBody;
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const props = body.properties;
  if (props && typeof props === "object") {
    const names = Object.keys(props);
    if (names.length === 0) return undefined;
    const head = names.slice(0, 4).join(" · ");
    return names.length > 4 ? `${head} …+${names.length - 4}` : head;
  }
  return typeof body.type === "string" ? body.type : undefined;
}

/**
 * A dropdown value back to a citation, or undefined when it is not one.
 *
 * Deliberately not `parseCitation` from @bcp/shared: that one answers "split
 * this citation string", so it reads `string` as `{name:"string"}`. Here the
 * same dropdown carries primitive types, sentinels (`enum`/`any`/`__register__`)
 * AND citations, so the question is "is this a citation at all" — it has to be
 * able to say no. The two call sites this replaces disagreed on that: one
 * accepted any `@` past index 0, the other required a positive integer version.
 */
export function citationFromOption(value: string): { name: string; version: number } | undefined {
  const at = value.lastIndexOf("@");
  if (at <= 0) return undefined;
  const version = Number(value.slice(at + 1));
  return Number.isInteger(version) && version > 0 ? { name: value.slice(0, at), version } : undefined;
}

/**
 * Dropdown sizing shared by every schema selector.
 *
 * The control itself is often laid out at 34% of a 320px inspector, but a
 * registry label is `name@version · title` and routinely runs past 30
 * characters — matching the popup to the control turned every option into
 * `book-i…`, which is not a choice anyone can make. The popup therefore sizes
 * to its content, capped so a long title cannot run off-screen.
 *
 * (Virtualisation stays off via BcpSelect's default: these lists mix one-line
 * options (基础类型) with two-line registry entries, and antd's virtual list
 * can only measure ONE row height for all of them — sizing it for the tall
 * ones leaves the short ones floating in 空白, sizing it for the short ones
 * clips the summary that was the point of adding it.)
 */
const POPUP_PROPS = {
  popupMatchSelectWidth: false,
  styles: { popup: { root: { maxWidth: 520, minWidth: 260 } } },
  listHeight: 320,
} as const;

/** Render an option on one line, with the full text available on hover. */
function optionLabel(text: string): JSX.Element {
  return <span title={text} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>;
}

/** A registry option as two lines: the citation, and what is inside it. The
 *  second line is the whole reason someone can pick the right contract from the
 *  list instead of citing one and then discovering it was the wrong shape. */
function registryOptionLabel(option: RegistryOption): JSX.Element {
  // Two lines each, not one: a citation like `doudian-product-canonical@3 · 抖店
  // 商品规范` and a field list both routinely run past one line at 260-520px, and
  // a single-line clamp cut them at the exact point where they stop being
  // distinguishable from a sibling entry. `title` carries the untruncated text
  // for the cases where even two lines are not enough.
  const clamp2 = {
    display: "-webkit-box" as const,
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
    wordBreak: "break-word" as const,
  };
  return (
    <span title={option.fields ? `${option.label}\n${option.fields}` : option.label} style={{ display: "block", overflow: "hidden", padding: "2px 0" }}>
      <span style={{ ...clamp2, lineHeight: 1.35 }}>{option.label}</span>
      {option.fields && (
        <span style={{ ...clamp2, fontSize: 11, opacity: 0.6, lineHeight: 1.3 }}>{option.fields}</span>
      )}
    </span>
  );
}

export function SchemaDetailsDrawer({ row, onClose }: { row: SchemaRow | null; onClose: () => void }): JSX.Element {
  return (
    <Drawer width={680} open={!!row} onClose={onClose} title={row ? `${row.name}@${row.version}` : "Schema 详情"}>
      {row && (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Space wrap size={[6, 4]}>
            <Tag color={row.active ? "green" : "default"}>{row.active ? "当前版本" : "已停用"}</Tag>
            <Tag>{SCHEMA_KIND_LABELS[row.kind as SchemaKind] ?? row.kind}</Tag>
            {row.entity && <Tag>{row.entity}</Tag>}
          </Space>
          {row.title && <Typography.Title level={5} style={{ margin: 0 }}>{row.title}</Typography.Title>}
          <Typography.Text type="secondary">{row.description ?? "暂无字段说明"}</Typography.Text>
          <Typography.Text type="secondary">来源：{row.source} · 指纹：{row.contentHash.slice(0, 16)}…</Typography.Text>
          {row.derivesFrom && <Typography.Text type="secondary">投影自：{row.derivesFrom}</Typography.Text>}
          <JsonEditor readOnly value={prettySchema(row.jsonSchema)} height={480} ariaLabel="JSON Schema 详情" />
        </Space>
      )}
    </Drawer>
  );
}

export function SchemaRegisterModal({
  open,
  schemas,
  seedName,
  seedSchema,
  onClose,
  onCreated,
}: {
  open: boolean;
  schemas: SchemaRow[];
  seedName?: string;
  seedSchema?: ParamSchemaFragment;
  onClose: () => void;
  onCreated: (row: SchemaRow) => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ name: string; kind: SchemaKind; entity?: string; description?: string; version: number; jsonSchema: string }>();
  const values = Form.useWatch([], form);
  const [openKey, setOpenKey] = useState(0);
  const register = useMutation({
    mutationFn: async (v: { name: string; kind: SchemaKind; entity?: string; description?: string; version: number; jsonSchema: string }) => {
      let jsonSchema: unknown;
      try { jsonSchema = JSON.parse(v.jsonSchema); } catch (e) { throw new Error(`JSON Schema 不是合法 JSON：${(e as Error).message}`); }
      return api.registerSchema({ name: v.name.trim(), kind: v.kind, entity: v.entity?.trim() || null, description: v.description?.trim() || null, version: v.version, jsonSchema });
    },
    onSuccess: (row) => { message.success(`${row.name}@${row.version} 已注册`); qc.invalidateQueries({ queryKey: ["schemas"] }); onCreated(row); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });
  useEffect(() => { if (open) { setOpenKey((key) => key + 1); form.resetFields(); } }, [open]);
  if (!open) return null;
  const proposed = seedName?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-schema";
  const nextVersion = Math.max(0, ...schemas.filter((s) => s.name === proposed).map((s) => s.version)) + 1;
  const problems = values?.name && values?.kind ? checkSchemaContract({ name: values.name, kind: values.kind, entity: values.entity || null, upstreamRef: null, derivesFrom: null }) : [];
  return (
    <Modal
      key={openKey}
      open
      width={760}
      title="注册新 Schema"
      onCancel={onClose}
      okText="注册并应用"
      confirmLoading={register.isPending}
      okButtonProps={{ disabled: problems.length > 0 }}
      onOk={() => form.validateFields().then((v) => register.mutate(v))}
    >
      {problems.length > 0 && <Alert type="error" showIcon message="请先修正 Schema 元数据" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ name: proposed, kind: "entity", version: nextVersion, jsonSchema: JSON.stringify(seedSchema ?? { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false }, null, 2) }}
      >
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="name" label="名称" style={{ flex: 1 }} rules={[{ required: true }, { pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/, message: "使用 kebab-case" }]}>
            <Input placeholder="canonical-product" />
          </Form.Item>
          <Form.Item name="version" label="版本" style={{ width: 120 }} rules={[{ required: true, type: "number", min: 1 }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="kind" label="角色" style={{ width: 150 }} rules={[{ required: true }]}>
            <BcpSelect options={SCHEMA_KINDS.map((kind) => ({ value: kind, label: SCHEMA_KIND_LABELS[kind] }))} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="entity" label="主题" style={{ flex: 1 }}><Input placeholder="product" /></Form.Item>
          <Form.Item name="description" label="说明" style={{ flex: 2 }}><Input placeholder="这份契约描述什么" /></Form.Item>
        </Space>
        <Form.Item name="jsonSchema" label="JSON Schema" rules={[{ required: true, message: "请输入 JSON Schema" }]}>
          <JsonEditor height={320} ariaLabel="JSON Schema 编辑器" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function SchemaPropertiesPreview({ row }: { row: SchemaRow }): JSX.Element | null {
  try {
    const document = JSON.parse(row.jsonSchema) as { properties?: Record<string, { description?: unknown }> };
    const properties = Object.entries(document.properties ?? {}).filter(([, property]) => typeof property?.description === "string").slice(0, 5);
    if (properties.length === 0) return null;
    return (
      <div style={{ marginTop: 4, padding: "5px 7px", background: "var(--c-subtle)", borderRadius: 4 }}>
        {properties.map(([name, property]) => <div key={name} style={{ fontSize: 11, lineHeight: 1.5 }}><Typography.Text code style={{ fontSize: 11 }}>{name}</Typography.Text><Typography.Text type="secondary">：{property.description as string}</Typography.Text></div>)}
        {Object.keys(document.properties ?? {}).length > properties.length && <Typography.Text type="secondary" style={{ fontSize: 11 }}>还有更多字段，打开详情查看</Typography.Text>}
      </div>
    );
  } catch {
    return null;
  }
}

/** A citation selector shared by node-level contract editors. */
export function SchemaRefSelect({
  schemas,
  value,
  onChange,
}: {
  schemas: SchemaRow[];
  value: { name: string; version?: number } | undefined;
  onChange: (ref: { name: string; version: number } | undefined) => void;
}): JSX.Element {
  const [viewing, setViewing] = useState<SchemaRow | null>(null);
  const [registering, setRegistering] = useState(false);
  const selected = value ? schemaCitationLabel(value) : undefined;
  const selectedRow = schemaForCitation(schemas, value);
  const options = buildRegistryOptions(schemas, selected).map((option) => ({ ...option, label: registryOptionLabel(option) }));
  return (
    <>
      <Space.Compact style={{ width: "100%" }}>
        <BcpSelect
          {...POPUP_PROPS}
          style={{ width: "calc(100% - 70px)" }}
          allowClear
          optionFilterProp="search"
          placeholder="从 Schema 注册表选（可留空）"
          value={selected}
          options={options}
          onChange={(citation: string | undefined) => onChange(citation ? citationFromOption(citation) : undefined)}
        />
        <Button icon={<EyeOutlined />} disabled={!selectedRow} title="查看 Schema" onClick={() => selectedRow && setViewing(selectedRow)} />
      </Space.Compact>
      <Space size={6} style={{ marginTop: 5 }}>
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setRegistering(true)}>注册新 Schema</Button>
        {value && !selectedRow && <Typography.Text type="danger" style={{ fontSize: 11 }}>引用失效：{schemaCitationLabel(value)}</Typography.Text>}
        {selectedRow && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{schemaSummary(selectedRow)}</Typography.Text>}
      </Space>
      {selectedRow && <SchemaPropertiesPreview row={selectedRow} />}
      <SchemaDetailsDrawer row={viewing} onClose={() => setViewing(null)} />
      <SchemaRegisterModal open={registering} schemas={schemas} seedName={value?.name} onClose={() => setRegistering(false)} onCreated={(row) => onChange({ name: row.name, version: row.version })} />
    </>
  );
}

export function FieldTypeSelect({
  schemas,
  value,
  onChange,
  style,
}: {
  schemas: SchemaRow[];
  value: ParamSpec;
  onChange: (next: Partial<ParamSpec>) => void;
  style?: CSSProperties;
}): JSX.Element {
  const [registering, setRegistering] = useState(false);
  const current = value.schemaRef
    ? `${value.schemaRef.name}@${value.schemaRef.version}`
    : value.schema?.enum ? "enum" : value.schema?.type ?? "string";
  const currentRow = schemaForCitation(schemas, value.schemaRef);
  const registryOptions = buildRegistryOptions(schemas, current);
  if (value.schemaRef && !registryOptions.some((option) => option.value === current)) {
    registryOptions.push({ value: current, label: `${current} · 引用失效`, search: current.toLowerCase() });
  }
  const options = [
    { label: "基础类型", options: PARAM_TYPES.map((type) => ({ value: type, label: optionLabel(type), search: type })) },
    { label: "已有 Schema", options: registryOptions.map((option) => ({ ...option, label: registryOptionLabel(option) })) },
    { label: "其它", options: [
      { value: "enum", label: optionLabel("枚举"), search: "enum 枚举" },
      { value: "any", label: optionLabel("未声明"), search: "any 未声明" },
    ] },
    // Its own group, because selecting it does not set a value — it opens the
    // register modal. Sitting among the types it read as "a type called 注册新
    // Schema", and picking it looked like it had failed to take.
    { label: "动作", options: [{ value: "__register__", label: optionLabel("＋ 注册新 Schema…"), search: "register 注册 schema" }] },
  ];
  const applyType = (next: Partial<ParamSpec>) => {
    const nextLabel = next.schemaRef ? schemaCitationLabel(next.schemaRef) : next.schema?.enum ? "枚举" : next.schema?.type ?? "未声明";
    if (current !== nextLabel && (value.schemaRef || value.schema?.type || value.schema?.enum)) {
      Modal.confirm({
        title: "确认修改字段类型？",
        content: "这会重新判定相关连线；当前常量如果不符合新类型会保留并标红。",
        okText: "继续修改",
        cancelText: "取消",
        onOk: () => onChange(next),
      });
      return;
    }
    onChange(next);
  };
  return (
    <>
      <BcpSelect
        {...POPUP_PROPS}
        style={style}
        value={current}
        options={options}
        optionFilterProp="search"
        onChange={(next: string) => {
          if (next === "__register__") return setRegistering(true);
          if (next === "enum") return applyType({ schemaRef: undefined, schema: { type: "string", enum: [""] } });
          if (next === "any") return applyType({ schemaRef: undefined, schema: {} });
          const citation = citationFromOption(next);
          if (citation) return applyType({ schema: undefined, schemaRef: citation });
          // An array keeps whatever element type was already chosen; picking the
          // element is a separate act (see ArrayItemTypeSelect), so switching
          // string → array → string must not silently discard it.
          if (next === "array") return applyType({ schemaRef: undefined, schema: { type: "array", items: value.schema?.items ?? {} } });
          applyType({ schemaRef: undefined, schema: { type: next } });
        }}
      />
      <SchemaRegisterModal open={registering} schemas={schemas} seedName={value.name} onClose={() => setRegistering(false)} onCreated={(row) => applyType({ schema: undefined, schemaRef: { name: row.name, version: row.version } })} />
      {currentRow && <span aria-hidden="true" style={{ display: "none" }}>{currentRow.id}</span>}
    </>
  );
}

/** True when this field is an array, i.e. when an element type is meaningful. */
export function isArrayField(param: Pick<ParamSpec, "schema" | "schemaRef">): boolean {
  return !param.schemaRef && param.schema?.type === "array";
}

/**
 * The element type of an array field.
 *
 * Without this the UI could only ever write a bare `{type:"array"}`, which
 * every downstream check reads as "array of anything": `isAssignable` cannot
 * refuse a mismatched wire, `mapPorts` projects an untyped item port, and the
 * author gets a warning they have no way to answer. The engine has always
 * modelled `items` — only the editor could not write it.
 *
 * A registry citation is carried the same way a field-level ref is carried
 * anywhere else in an inline schema: the `x-bcp-schema-ref` keyword, which ajv
 * ignores under strict:false.
 */
export function ArrayItemTypeSelect({
  schemas,
  value,
  onChange,
  style,
}: {
  schemas: SchemaRow[];
  value: ParamSpec;
  onChange: (next: Partial<ParamSpec>) => void;
  style?: CSSProperties;
}): JSX.Element {
  const items = (value.schema?.items ?? {}) as ParamSchemaFragment & { [SCHEMA_REF_KEYWORD]?: { name: string; version?: number } };
  const ref = items[SCHEMA_REF_KEYWORD];
  const current = ref ? `${ref.name}@${ref.version}` : items.type ?? "any";
  const registryOptions = buildRegistryOptions(schemas, current);
  const options = [
    { label: "基础类型", options: PARAM_TYPES.filter((type) => type !== "array").map((type) => ({ value: type, label: optionLabel(type), search: type })) },
    { label: "已有 Schema", options: registryOptions.map((option) => ({ ...option, label: registryOptionLabel(option) })) },
    { label: "其它", options: [{ value: "any", label: optionLabel("未声明"), search: "any 未声明" }] },
  ];
  const setItems = (next: ParamSchemaFragment) => onChange({ schema: { ...value.schema, type: "array", items: next } });
  return (
    <BcpSelect
      {...POPUP_PROPS}
      style={style}
      value={current}
      options={options}
      optionFilterProp="search"
      placeholder="元素类型"
      onChange={(next: string) => {
        if (next === "any") return setItems({});
        const citation = citationFromOption(next);
        setItems(citation ? ({ [SCHEMA_REF_KEYWORD]: citation } as ParamSchemaFragment) : { type: next });
      }}
    />
  );
}

export function SchemaFieldMeta({ schemas, refValue }: { schemas: SchemaRow[]; refValue: { name: string; version?: number } }): JSX.Element {
  const [viewing, setViewing] = useState<SchemaRow | null>(null);
  const row = schemaForCitation(schemas, refValue);
  return (
    <>
      <Space size={4} style={{ margin: "2px 0 0 4px" }}>
        <Typography.Text type={row ? "secondary" : "danger"} style={{ fontSize: 11 }}>
          {row ? `${schemaCitationLabel(refValue)} · ${schemaSummary(row) ?? "无结构摘要"}` : `引用失效：${schemaCitationLabel(refValue)}`}
        </Typography.Text>
        {row && <Button type="link" size="small" icon={<EyeOutlined />} style={{ padding: 0, height: 18 }} onClick={() => setViewing(row)}>查看</Button>}
      </Space>
      {row && <SchemaPropertiesPreview row={row} />}
      <SchemaDetailsDrawer row={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
