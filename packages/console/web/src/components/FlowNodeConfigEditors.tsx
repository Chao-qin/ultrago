/**
 * Per-node-type config editors: branch cases, merge inputs, transform outputs
 * and the literal typed into an unconnected input port.
 *
 * Split out of FlowEditor.tsx — each one edits a different node's `config`,
 * and none of them is used anywhere but the inspector.
 */
import { Button, Input, InputNumber, Modal, Space, Tag, Tooltip, Typography, theme } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { portTypeLabel } from "@bcp/shared";
import type { ParamSchemaFragment, TransformOutput } from "@bcp/shared";
import { BRANCH_OPERATORS, BRANCH_OPERATOR_LABELS, isUnaryBranchOperator, transformOutputKey } from "../lib/types";
import type { BranchCase, BranchNodeConfig, FlowPort, MergeNodeConfig, SchemaRow } from "../lib/types";
import { mintPortId } from "../lib/flow-ports-client";
import { ArrayItemTypeSelect, FieldTypeSelect, SchemaFieldMeta, isArrayField } from "./SchemaSelect";
import { BcpSelect } from "./BcpSelect";
import { EnumValueInput, JsonValueInput } from './typed-value-input';

/** What a node is bound to, in one line. Deliberately not the node id: the id
 *  is already the fallback title, and repeating it says nothing new.
 *
 *  `booksLoaded` is separate from an empty map on purpose: before the book list
 *  arrives every binding looks unresolvable, and reporting that as a deleted
 *  book would put a false accusation on the card for the first second of every
 *  page load. Not knowing yet and knowing it is gone are different answers. */
/**
 * The cases of a branch, each one an output port.
 *
 * Three controls per row — a path, an operator from a CLOSED list, and a value
 * — and deliberately not one box holding an expression. `doubao-ask` once
 * exposed a parameter whose value was JavaScript and a plain Chinese greeting
 * came back as `你好 is not defined`; a flow is an outer caller of exactly that
 * kind, so the rule is stronger here. Anything a comparison cannot say belongs
 * in a script node.
 */
export function BranchCasesEditor({
  config,
  onChange,
}: {
  config: BranchNodeConfig;
  onChange: (config: BranchNodeConfig) => void;
}): JSX.Element {
  const cases = config.cases ?? [];
  const patch = (index: number, next: Partial<BranchCase>): void =>
    onChange({ ...config, cases: cases.map((c, i) => (i === index ? { ...c, ...next } : c)) });

  return (
    <div>
      <Typography.Text type="secondary">判断条件（自上而下，第一个命中的赢）</Typography.Text>
      {cases.map((branchCase, index) => (
        // Keyed by the STABLE port id, never the index: a wire remembers that
        // id, and re-keying on reorder is how a row's edits land on its
        // neighbour.
        <div key={branchCase.id} className='flow-branch-condition'>
          <Input.TextArea
            size="small"
            className='flow-branch-path'
            aria-label={`条件 ${index + 1} 路径`}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder="$.status"
            value={branchCase.left}
            onChange={(e) => patch(index, { left: e.target.value })}
          />
          <BcpSelect
            size="small"
            style={{ flex: "0 0 104px" }}
            value={branchCase.op}
            options={BRANCH_OPERATORS.map((op) => ({ value: op, label: BRANCH_OPERATOR_LABELS[op] }))}
            onChange={(op) => patch(index, { op })}
          />
          {!isUnaryBranchOperator(branchCase.op) && (
            <Input
              size="small"
              style={{ flex: "1 1 70px" }}
              placeholder="值"
              value={branchCase.right ?? ""}
              onChange={(e) => patch(index, { right: e.target.value })}
            />
          )}
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            // Removing a case removes a PORT; the caller drops the wires that
            // were on it, the same way the transform editor does. That makes it
            // exactly as destructive as the other field-list deletions, and it
            // was the only one going through without a confirm.
            onClick={() =>
              Modal.confirm({
                title: `删除第 ${index + 1} 个条件？`,
                content: "这一路的输出端口会消失，接在上面的连线也会被移除。此操作可以通过撤销恢复。",
                okText: "删除",
                okType: "danger",
                cancelText: "取消",
                onOk: () => onChange({ ...config, cases: cases.filter((_, i) => i !== index) }),
              })
            }
          />
        </div>
      ))}
      <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 8 }}>
        <Button
          block
          size="small"
          icon={<PlusOutlined />}
          onClick={() => onChange({ ...config, cases: [...cases, { id: mintPortId(), left: "$", op: "eq", right: "" }] })}
        >
          加一条
        </Button>
        <Tooltip title="没有任何条件命中时走这个端口。不开的话，都不中就直接跳过下游 —— 那也是合法结局。">
          <Button
            size="small"
            type={config.otherwise ? "primary" : "default"}
            onClick={() => onChange({ ...config, otherwise: !config.otherwise })}
          >
            其它情况
          </Button>
        </Tooltip>
      </Space>
    </div>
  );
}

/** A merge's inputs. Adding one adds a port; nothing more, because "which one
 *  arrived" is the only question a join has to answer. */
export function MergeInputsEditor({
  config,
  onChange,
}: {
  config: MergeNodeConfig;
  onChange: (config: MergeNodeConfig) => void;
}): JSX.Element {
  const inputs = config.inputs ?? [];
  return (
    <div>
      <Typography.Text type="secondary">汇合入口（按顺序取第一个有值的）</Typography.Text>
      {inputs.map((input, index) => (
        <div key={input.id} style={{ display: "flex", gap: 4, marginTop: 6, alignItems: "center" }}>
          <Input
            size="small"
            placeholder={`输入 ${index + 1}`}
            value={input.label ?? ""}
            onChange={(e) =>
              onChange({ ...config, inputs: inputs.map((v, i) => (i === index ? { ...v, label: e.target.value } : v)) })
            }
          />
          <Tooltip title={inputs.length <= 2 ? "汇合至少要两路，否则它就不是汇合了" : undefined}>
            <Button
              size="small"
              type="text"
              danger
              disabled={inputs.length <= 2}
              icon={<DeleteOutlined />}
              onClick={() =>
                Modal.confirm({
                  title: `删除「${input.label?.trim() || `输入 ${index + 1}`}」？`,
                  content: "这一路的入口会消失，接在上面的连线也会被移除。此操作可以通过撤销恢复。",
                  okText: "删除",
                  okType: "danger",
                  cancelText: "取消",
                  onOk: () => onChange({ ...config, inputs: inputs.filter((_, i) => i !== index) }),
                })
              }
            />
          </Tooltip>
        </div>
      ))}
      <Button
        block
        size="small"
        style={{ marginTop: 8 }}
        icon={<PlusOutlined />}
        onClick={() => onChange({ ...config, inputs: [...inputs, { id: mintPortId() }] })}
      >
        加一路
      </Button>
    </div>
  );
}

/**
 * A literal typed into an input port that has no wire.
 *
 * The runner has always honoured these — `resolveInputs` seeds a node's inputs
 * from `config.constants` and lets a wire override the same port — and
 * `validatePorts` counts one as satisfying a required input. Nothing on the
 * canvas could write one, so the only way to hand a node a fixed value was to
 * declare a flow parameter for it and wire that up.
 *
 * The value is stored as the port's declared TYPE, not as the text that was
 * typed: `resolveInputs` passes it straight to the endpoint, so a "3" left as a
 * string would arrive at a number port and fail inside the book rather than
 * here. Invalid structured drafts remain visible to graph validation, so a
 * save cannot silently replace an unfinished edit with an older value.
 */
export function ConstantField({ port, value, onChange }: { port: FlowPort; value: unknown; onChange: (next: unknown) => void }) {
  const type = typeof port.schema?.type === "string" ? port.schema.type : undefined;
  const options = port.schema?.enum;
  if (Array.isArray(options)) return <EnumValueInput options={options} value={value} onChange={onChange} />;
  if (type === "boolean") {
    return <EnumValueInput options={[true, false]} value={value} onChange={onChange} />;
  }
  if (type === "number" || type === "integer") {
    return <InputNumber style={{ width: '100%' }} value={typeof value === 'number' ? value : undefined} onChange={(next) => onChange(next ?? undefined)} placeholder="填入数值" />;
  }
  if (type === "object" || type === "array") {
    return <JsonValueInput value={value} onChange={onChange} height={112} expected={type === 'object' ? 'object' : 'any'} />;
  }
  return <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} value={value === undefined ? '' : String(value)}
    placeholder="填个常量值（可留空）" onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)} />;
}

/**
 * A transform node's outputs: a name and how to derive it.
 *
 * The expression grammar is deliberately tiny — a `$` path, a `{{token}}`
 * template, or a literal. There is no expression language and there will not be
 * one: a book once accepted caller-written JavaScript as a parameter and a plain
 * greeting became `你好 is not defined`. Anything needing a conditional or a
 * loop belongs in a script endpoint, which has a file, a version and tests.
 */
/** The one field-list editor that is NOT ParamListEditor, because a mapping row
 *  carries an expression instead of a required flag. Everything else about it
 *  was allowed to drift — no element type for arrays, no idea what the upstream
 *  offers, three unlabelled boxes summing to 104% — and this brings those back
 *  in line with the rest of the inspector. */
export function TransformOutputEditor({
  outputs,
  schemas,
  inputSchema,
  onChange,
}: {
  outputs: TransformOutput[];
  schemas: SchemaRow[];
  /** The contract arriving on the input port, so the author can be told which
   *  paths actually exist instead of typing `$.a.b` blind. Null until something
   *  is wired in (or when the upstream declares nothing). */
  inputSchema: ParamSchemaFragment | null;
  onChange: (next: TransformOutput[]) => void;
}) {
  const { token } = theme.useToken();
  const patch = (index: number, next: Partial<TransformOutput>) =>
    onChange(outputs.map((o, i) => (i === index ? { ...o, ...next } : o)));
  const upstream = upstreamFields(inputSchema);

  return (
    <div>
      <Typography.Text type="secondary">输出字段</Typography.Text>
      {/* Column headers: three bare boxes gave no clue which was which, and the
          expression column in particular reads as "some other name field". */}
      <div style={{ display: "flex", gap: 4, margin: "4px 0 2px", fontSize: 11, color: token.colorTextTertiary }}>
        <span style={{ width: "34%" }}>输出名</span>
        <span style={{ width: "28%" }}>类型</span>
        <span style={{ flex: 1 }}>取值</span>
        <span style={{ width: 32 }} />
      </div>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {outputs.map((out, index) => (
          <span key={out.id} style={{ display: "block" }}>
          <Space.Compact style={{ width: "100%" }}>
            {/* Writes `label`, never `id`. `id` is the handle every wire on
                this output remembers; it was also this box's value until
                2026-08-29, so renaming a field unhooked it. `transformOutputKey`
                is what makes the two agree — the name typed here is still the
                key the value is produced under. */}
            <Input
              style={{ width: "34%" }}
              placeholder="输出名"
              value={transformOutputKey(out)}
              status={!transformOutputKey(out).trim() ? "error" : undefined}
              onChange={(e) => patch(index, { label: e.target.value })}
            />
            <FieldTypeSelect
              style={{ width: "28%" }}
              schemas={schemas}
              value={{ name: transformOutputKey(out), required: false, schema: out.schema, schemaRef: out.schemaRef }}
              onChange={(next) => patch(index, { schema: next.schema, schemaRef: next.schemaRef })}
            />
            <Input
              style={{ flex: 1 }}
              placeholder="$.data.url 或 {{name}}.md"
              value={out.expr}
              status={out.expr.trim() ? undefined : "error"}
              onChange={(e) => patch(index, { expr: e.target.value })}
            />
            <Button danger icon={<DeleteOutlined />} onClick={() => Modal.confirm({ title: `删除输出「${transformOutputKey(out)}」？`, content: "相关连线会被移除，此操作可以通过撤销恢复。", okText: "删除", okType: "danger", cancelText: "取消", onOk: () => onChange(outputs.filter((_, i) => i !== index)) })} />
          </Space.Compact>
          {/* Same二级控件 as ParamListEditor: an array without an element type
              is a contract nothing downstream can use — `isAssignable` cannot
              refuse a mismatched wire against `items: {}`, and a map fed from
              this output hands its body an untyped item. This editor was the
              only field list that could not express it. */}
          {isArrayField({ schema: out.schema, schemaRef: out.schemaRef }) && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, margin: "4px 0 0 4px" }}>
              <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>元素类型</Typography.Text>
              <ArrayItemTypeSelect
                style={{ flex: 1, minWidth: 0 }}
                schemas={schemas}
                value={{ name: transformOutputKey(out), required: false, schema: out.schema, schemaRef: out.schemaRef }}
                onChange={(next) => patch(index, { schema: next.schema, schemaRef: next.schemaRef })}
              />
            </span>
          )}
          {out.schemaRef && <SchemaFieldMeta schemas={schemas} refValue={out.schemaRef} />}
          </span>
        ))}
        <Button
          block
          size="small"
          icon={<PlusOutlined />}
          onClick={() => onChange([...outputs, { id: mintPortId(), label: `out${outputs.length + 1}`, expr: "$" }])}
        >
          添加输出
        </Button>
      </Space>
      {/* What the upstream actually offers. Before the input port carried a
          schema at all (it was hardcoded null, see propagateRouterSchemas) there
          was nothing to show here and every path was typed from memory. */}
      {upstream.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>上游字段（点一下填进最后一行的取值）</Typography.Text>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
            {upstream.map((f) => (
              <Tag
                key={f.path}
                style={{ cursor: outputs.length ? "pointer" : "default", margin: 0, fontSize: 11 }}
                onClick={() => outputs.length && patch(outputs.length - 1, { expr: f.path })}
              >
                {f.path}
                {f.type && <span style={{ color: token.colorTextQuaternary }}> · {f.type}</span>}
              </Tag>
            ))}
          </div>
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
        取值写 <code>$.a.b</code> / <code>$.items[0]</code>，拼接写 <code>{"{{name}}"}-{"{{n}}"}.md</code>，其余按字面量。
        需要判断或循环请改用「本地脚本」节点。
      </Typography.Text>
    </div>
  );
}

/** The top-level fields of the shape arriving on a transform's input, as `$.x`
 *  paths. One level only: deeper nesting is what the box is for, and a wall of
 *  every leaf path would bury the fields that are actually being mapped. */
function upstreamFields(schema: ParamSchemaFragment | null): Array<{ path: string; type: string | null }> {
  const properties = schema && typeof schema === "object" ? (schema as { properties?: Record<string, ParamSchemaFragment> }).properties : undefined;
  if (!properties) return [];
  return Object.entries(properties)
    .slice(0, 24)
    .map(([name, sub]) => ({ path: `$.${name}`, type: portTypeLabel(sub) }));
}
