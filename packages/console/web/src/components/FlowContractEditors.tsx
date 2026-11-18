/**
 * The contract panels: what a node declares it takes and gives.
 *
 * Split out of FlowEditor.tsx. All four wrap the same field-list editor and
 * differ only in which config keys they read and write, which is why they
 * belong together.
 */
import { useMemo } from "react";
import { Segmented, Space, Typography } from "antd";
import type { FlowInputNodeConfig, FlowOutputNodeConfig, ParamSchemaFragment, ParamSpec } from "@bcp/shared";
import { flowInputParams } from "../lib/types";
import type { FlowNode, FlowPort, SchemaRow, ScriptNodeConfig } from "../lib/types";
import { mintPortId, schemaLookup } from "../lib/flow-ports-client";
import { paramsOfSchema, withConfig } from "../lib/flow-editor-model";
import { schemaOfParams } from '../lib/script-contract';
import { SchemaRefSelect } from "./SchemaSelect";
import { PortType } from "./FlowCanvasNodes";
import { useTheme, getPalette } from "../theme";
import { ParamListEditor } from './param-list-editor';

/**
 * A list of named, typed fields, edited in place.
 *
 * Written for the entry node — without it a flowInput could be dropped on the
 * canvas but never given a single parameter, so the whole flow was unable to
 * accept input. It serves the flowOutput node's inline contract too: naming
 * fields and picking their types is the same act on both sides of a flow, and
 * the wording is what differs, so the wording is what the props carry.
 */
/** Every parameter with a stable port id, minting one only where there is none.
 *
 *  This is the entry node's own concern, not `ParamListEditor`'s: the same
 *  editor serves the flowOutput node's inline fields, and those are round
 *  tripped through a JSON Schema that has no room for an id and no ports to
 *  need one. Rows that already have one are returned UNTOUCHED, which is the
 *  point — a new object for an untouched row would be a change nobody made. */
function withPortIds(params: ParamSpec[]): ParamSpec[] {
  return params.map((p) => (p.portId ? p : { ...p, portId: mintPortId() }));
}

/**
 * The field list, back as the object schema the port and the runner read.
 *
 * A row whose name is empty is kept, under "". Dropping it would be tidier in
 * the stored JSON and unusable in the panel: the list is re-derived from this
 * schema on every keystroke, so a field cleared in order to be retyped would
 * vanish from under the cursor. It is flagged red instead, exactly as an
 * unnamed flow parameter is on the entry node.
 */
/**
 * The flow's product contract, declared either way round.
 *
 * `portsFor` has always read `config.schema ?? schemaFor(config.schemaRef)`, so
 * an inline shape was already honoured everywhere — the canvas simply had no
 * way to write one, which meant wanting a throwaway `{ok: boolean}` obliged you
 * to register a schema first. The input side never asked for that: a flowInput
 * node's params are typed straight onto the card.
 *
 * The two modes are exclusive on purpose. Both keys can exist in stored JSON
 * and `schema` would win silently, so switching modes clears the other one
 * rather than leaving a ref that no longer describes anything.
 */
/** The flowInput panel, and the mirror image of `FlowOutputContract` below.
 *
 *  Until 2026-08-29 this node could only have its parameters hand-written,
 *  while the output node right next to it could cite the Schema registry. Same
 *  dialog, same job — declare a contract — and two different answers to "where
 *  does a contract come from". The registry already holds the `book-input-*`
 *  contracts these flows pass along, so retyping them per flow was both work
 *  and a place to drift.
 *
 *  Which one wins is decided once, in `flowInputParams` (shared), and read
 *  identically by the ports, the flow's stored input contract and the trigger
 *  dialog. This component only has to keep the two modes exclusive. */
export function FlowInputContract({
  config,
  schemas,
  onChange,
}: {
  config: FlowNode["config"];
  schemas: SchemaRow[];
  onChange: (next: FlowNode["config"]) => void;
}) {
  const schemaRef = (config as FlowInputNodeConfig).schemaRef;
  const params = (config as FlowInputNodeConfig).params ?? [];
  // Keyed off the INLINE marker, exactly as FlowOutputContract keys off its
  // inline `schema`. Keying off `schemaRef` instead is a chicken-and-egg:
  // switching to 注册表 cannot set a ref before one has been chosen, so the
  // mode flipped straight back and the picker never appeared (caught in the
  // browser, 2026-08-29 — typecheck and the unit tests were both green).
  const mode = params.length > 0 ? "inline" : "registry";
  const schemaFor = useMemo(() => schemaLookup(schemas), [schemas]);
  // What the node declares right now, whichever mode it is in — so switching to
  // "就地定义" starts from the fields the author was just looking at instead of
  // an empty list.
  const resolved = useMemo(() => flowInputParams(config, schemaFor), [config, schemaFor]);

  return (
    <div>
      <Typography.Text type="secondary">入参契约</Typography.Text>
      <Segmented
        size="small"
        block
        style={{ margin: "4px 0 6px" }}
        value={mode}
        options={[
          { value: "registry", label: "注册表" },
          { value: "inline", label: "就地定义" },
        ]}
        onChange={(next) =>
          onChange(
            next === "inline"
              // Seeded when the citation resolved to nothing: `params` IS the
              // mode marker, so handing back an empty list would bounce the
              // panel straight back to 注册表.
              ? withConfig(
                  withConfig(config, "schemaRef", undefined),
                  "params",
                  withPortIds(resolved.length > 0 ? resolved : [{ name: "param1", required: false, schema: { type: "string" } }]),
                )
              : withConfig(config, "params", []),
          )
        }
      />
      {mode === "registry" ? (
        <>
          <SchemaRefSelect
            schemas={schemas}
            value={schemaRef}
            onChange={(ref) => onChange(withConfig(config, "schemaRef", ref))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            引用的契约有几个字段，本节点就长出几个输出端口；留空表示不声明入参
          </Typography.Text>
        </>
      ) : (
        <ParamListEditor
          schemas={schemas}
          params={params}
          onChange={(next) => onChange(withConfig(config, "params", withPortIds(next)))}
        />
      )}
    </div>
  );
}

export function FlowOutputContract({
  config,
  schemas,
  onChange,
}: {
  config: FlowNode["config"];
  schemas: SchemaRow[];
  onChange: (next: FlowNode["config"]) => void;
}) {
  const inline = (config as FlowOutputNodeConfig).schema;
  const mode = inline ? "inline" : "registry";
  const fields = useMemo(() => paramsOfSchema(inline), [inline]);

  return (
    <div>
      <Typography.Text type="secondary">产出契约</Typography.Text>
      <Segmented
        size="small"
        block
        style={{ margin: "4px 0 6px" }}
        value={mode}
        options={[
          { value: "registry", label: "注册表" },
          { value: "inline", label: "就地定义" },
        ]}
        onChange={(next) =>
          onChange(
            next === "inline"
              ? withConfig(withConfig(config, "schemaRef", undefined), "schema", schemaOfParams(fields))
              : withConfig(config, "schema", undefined),
          )
        }
      />
      {mode === "registry" ? (
        <>
          <SchemaRefSelect
            schemas={schemas}
             value={(config as FlowOutputNodeConfig).schemaRef}
            onChange={(ref) => onChange(withConfig(config, "schemaRef", ref))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            留空表示不声明契约，连线时只能给提示，运行时才校验
          </Typography.Text>
        </>
      ) : (
        <ParamListEditor
          schemas={schemas}
          title="产出字段"
          namePlaceholder="字段名"
          addLabel="添加字段"
          hint="就地定义只属于这条流程；要跨流程复用，去 Schema 注册表登记一份再用「注册表」引用"
          params={fields}
          onChange={(params) => onChange(withConfig(config, "schema", schemaOfParams(params)))}
        />
      )}
    </div>
  );
}

/**
 * The script node's input contract, in either form.
 *
 * Mirrors `FlowInputContract`/`FlowOutputContract` above: a `Segmented`
 * switches between citing the registry and defining the shape inline, with
 * the other key cleared on switch so a save never carries both. The inline
 * form is the natural fit for a `command` script whose argv is hand-written
 * just below — without it, declaring `--capture $capturePath` would still
 * leave the panel saying "未声明".
 *
 * Switching to inline seeds from the resolved schema (when there is one) so a
 * user who picks inline from a registry citation does not start with an empty
 * list and lose what they were looking at.
 */
export function ScriptInputContract({
  config,
  schemas,
  onChange,
}: {
  config: FlowNode["config"];
  schemas: SchemaRow[];
  onChange: (next: FlowNode["config"]) => void;
}) {
  const script = config as ScriptNodeConfig;
  const inline = script.inputSchema;
  // `inputSchema` IS the mode marker — keys off its presence, not on
  // `inputSchemaRef`, for the same chicken-and-egg reason `FlowInputContract`
  // keys off `params.length`.
  const mode = inline ? "inline" : "registry";
  const fields = useMemo(() => paramsOfSchema(inline), [inline]);
  const schemaFor = useMemo(() => schemaLookup(schemas), [schemas]);
  const resolved = useMemo(() => {
    if (!script.inputSchemaRef) return [];
    const schema = schemaFor(script.inputSchemaRef);
    return schema ? paramsOfSchema(schema) : [];
  }, [script.inputSchemaRef, schemaFor]);

  return (
    <div>
      <Typography.Text type="secondary">入参契约</Typography.Text>
      <Segmented
        size="small"
        block
        style={{ margin: "4px 0 6px" }}
        value={mode}
        options={[
          { value: "registry", label: "注册表" },
          { value: "inline", label: "就地定义" },
        ]}
        onChange={(next) =>
          onChange(
            next === "inline"
              ? // Seeded so the panel stays in inline even when both inline and
                // resolved are empty — handing back `[]` would flip the mode
                // back to registry on the next render.
                withConfig(
                  withConfig(config, "inputSchemaRef", undefined),
                  "inputSchema",
                  schemaOfParams(resolved.length > 0 ? resolved : [{ name: "input1", required: false, schema: { type: "string" } }]),
                )
              : withConfig(config, "inputSchema", undefined),
          )
        }
      />
      {mode === "registry" ? (
        <>
          <SchemaRefSelect
            schemas={schemas}
             value={script.inputSchemaRef}
            onChange={(ref) => onChange(withConfig(config, "inputSchemaRef", ref))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            command 里写 <code>$name</code> 会替换为同名入参的值；不声明时只能手动接线
          </Typography.Text>
        </>
      ) : (
        <ParamListEditor
          schemas={schemas}
          title="入参字段"
          namePlaceholder="参数名"
          addLabel="添加参数"
          hint="每个字段长成本节点的一个输入端口；command 中 <code>$字段名</code> 会被替换为同名值"
          params={fields}
          onChange={(params) => onChange(withConfig(config, "inputSchema", schemaOfParams(params)))}
        />
      )}
    </div>
  );
}

/**
 * The script node's output contract, in either form. Same shape and tradeoffs
 * as `ScriptInputContract` — the schema is fed to `validateOutput` so the
 * runner can fail closed on a violation.
 */
export function ScriptOutputContract({
  config,
  schemas,
  onChange,
}: {
  config: FlowNode["config"];
  schemas: SchemaRow[];
  onChange: (next: FlowNode["config"]) => void;
}) {
  const script = config as ScriptNodeConfig;
  const inline = script.outputSchema;
  const mode = inline ? "inline" : "registry";
  const fields = useMemo(() => paramsOfSchema(inline), [inline]);
  const schemaFor = useMemo(() => schemaLookup(schemas), [schemas]);
  const resolved = useMemo(() => {
    if (!script.outputSchemaRef) return [];
    const schema = schemaFor(script.outputSchemaRef);
    return schema ? paramsOfSchema(schema) : [];
  }, [script.outputSchemaRef, schemaFor]);

  return (
    <div>
      <Typography.Text type="secondary">产出契约</Typography.Text>
      <Segmented
        size="small"
        block
        style={{ margin: "4px 0 6px" }}
        value={mode}
        options={[
          { value: "registry", label: "注册表" },
          { value: "inline", label: "就地定义" },
        ]}
        onChange={(next) =>
          onChange(
            next === "inline"
              ? withConfig(
                  withConfig(config, "outputSchemaRef", undefined),
                  "outputSchema",
                  schemaOfParams(resolved.length > 0 ? resolved : [{ name: "output1", required: false, schema: { type: "string" } }]),
                )
              : withConfig(config, "outputSchema", undefined),
          )
        }
      />
      {mode === "registry" ? (
        <>
          <SchemaRefSelect
            schemas={schemas}
             value={script.outputSchemaRef}
            onChange={(ref) => onChange(withConfig(config, "outputSchemaRef", ref))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            留空表示不声明契约，连线时只能给提示，运行时才校验
          </Typography.Text>
        </>
      ) : (
        <ParamListEditor
          schemas={schemas}
          title="产出字段"
          namePlaceholder="字段名"
          addLabel="添加字段"
          hint="就地定义只属于这条流程；要跨流程复用，去 Schema 注册表登记一份再用「注册表」引用"
          params={fields}
          onChange={(params) => onChange(withConfig(config, "outputSchema", schemaOfParams(params)))}
        />
      )}
    </div>
  );
}

/** A bound Book owns both sides of its contract, so this panel is intentionally
 * read-only. Editing the shape here would make the node disagree with the Book
 * that supplies it; the Book detail page is the source of that definition. */
/** The read-only contract view, for every node whose ports come from SOMEWHERE
 *  ELSE rather than from fields the author edits here: a book's declared
 *  params, a subflow's own contract, the shape a router inherited off its
 *  incoming wire. They differ only in what to say when there is nothing yet,
 *  which is why that is the one prop. Showing them the same way is the point —
 *  "what does this node take and give" should not look like a different kind of
 *  question depending on which node is selected. */
export function InheritedContract({ ports, emptyHint }: { ports: FlowPort[]; emptyHint: string }): JSX.Element {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const inputs = ports.filter((port) => port.direction === "in");
  const outputs = ports.filter((port) => port.direction === "out");
  if (ports.length === 0) {
    return <Typography.Text type="secondary">{emptyHint}</Typography.Text>;
  }
  const rows = (items: FlowPort[]) => (
    <Space direction="vertical" size={4} style={{ width: "100%" }}>
      {items.map((port) => (
        <div key={port.id} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
          <Typography.Text strong>{port.label}</Typography.Text>
          {port.required && <span style={{ color: palette.bad }}>*</span>}
          <PortType schema={port.schema} />
        </div>
      ))}
    </Space>
  );
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <div>
        <Typography.Text type="secondary">入参契约</Typography.Text>
        {inputs.length > 0 ? rows(inputs) : <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>无入参</Typography.Text>}
      </div>
      <div>
        <Typography.Text type="secondary">产出契约</Typography.Text>
        {outputs.length > 0 ? rows(outputs) : <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>无产出</Typography.Text>}
      </div>
    </Space>
  );
}
