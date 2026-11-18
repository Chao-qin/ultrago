/**
 * The flow canvas's own rendering: the node card, the edge, and the small
 * pieces they are built from.
 *
 * Split out of FlowEditor.tsx — these are what React Flow renders through
 * `nodeTypes` / `edgeTypes`, so they change for graphical reasons, not for
 * reasons the page's state machine cares about.
 */
import type { CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath } from "@xyflow/react";
import type { EdgeProps, NodeProps } from "@xyflow/react";
import { Popover, Tag, Tooltip, Typography, theme } from 'antd';
import { portTypeLabel } from "@bcp/shared";
import type { ParamSchemaFragment } from "@bcp/shared";
import { FLOW_NODE_TYPE_LABELS } from "../lib/types";
import type { Compat, FlowNode, FlowNodeType, FlowPort } from "../lib/types";
import { NodeIcon } from "./NodeIcon";
import { LoadingOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { useTheme, getPalette } from "../theme";

/**
 * A port's type, on the card.
 *
 * Both states are shown, and that is the whole point: a known contract used to
 * render as nothing at all while a missing one rendered `·未声明`, so the graph
 * looked untyped whether or not it was. It was typed — schemas propagate
 * through branch, merge, map and collect — and a reader had no way to tell.
 */
export function PortType({ schema }: { schema: ParamSchemaFragment | null | undefined }): JSX.Element {
  const { token } = theme.useToken();
  const label = portTypeLabel(schema);
  if (!label) {
    return (
      <Tooltip title="未声明契约，连线时只能给出提示，运行时才校验">
        <span style={{ color: token.colorTextQuaternary }}> ·未声明</span>
      </Tooltip>
    );
  }
  return (
    <Popover
      trigger={['hover', 'click']}
      title='数据契约'
      arrow={false}
      align={{ offset: [0, 0], overflow: { shiftX: true, shiftY: true, adjustX: true, adjustY: true } }}
      classNames={{ root: 'contract-preview' }}
      content={<pre className='contract-preview-code nowheel' tabIndex={0} aria-label='契约 JSON'>{JSON.stringify(schema, null, 2)}</pre>}
    >
      <button type='button' className='port-type-trigger nodrag nopan' aria-label={`查看契约：${label}`}> ·{label}</button>
    </Popover>
  );
}

export interface NodeData extends Record<string, unknown> {
  flowNode: FlowNode;
  ports: FlowPort[];
  /** What this node is BOUND to, as opposed to what kind of node it is.
   *  Resolved by the page because only the page has the book list. */
  subtitle?: string;
  /** Status of this node in the most recent run, when there is one. */
  runStatus?: string;
}

/** How a node's live status reads on the card. Grey is deliberately the
 *  fallback: an unknown status must not borrow the colour of a known one. */
function getRunStatusStyle(p: ReturnType<typeof getPalette>): Record<string, { color: string; label: string }> { return {
  pending: { color: p.ink3, label: "等待" },
  running: { color: p.info, label: "运行中" },
  success: { color: p.ok, label: '成功' },
  queued: { color: p.ink3, label: '排队中' },
  paused: { color: p.warn, label: '已暂停' },
  succeeded: { color: p.ok, label: "成功" },
  failed: { color: p.bad, label: "失败" },
  skipped: { color: p.ink3, label: "跳过" },
  cancelled: { color: p.ink3, label: "已取消" },
}; }

/** A node with no ports has nowhere for a wire to land, which is the single
 *  most common reason a connection "won't work". Say what is missing rather
 *  than just "未配置". */
const EMPTY_HINT: Record<FlowNodeType, string> = {
  flowInput: "点开右侧面板添加参数，每个参数会成为一个输出端口",
  book: "点开右侧面板绑定一本 Book，入参与产出会自动长出端口",
  script: "点开右侧面板写代码或填命令，并声明出入参契约",
  transform: "点开右侧面板添加输出字段",
  flow: "点开右侧面板选一条流程，它的出入参会长成这个节点的端口",
  branch: "点开右侧面板添加判断条件，每个条件是一个输出端口",
  merge: "把分支的几条路接进来，先到的那一路继续往下走",
  map: "接一个数组，下游会对每一项各跑一遍；结果送到「收集结果」",
  collect: "「逐项处理」的每一项结果送到这里，全部跑完后合成一个数组",
  flowOutput: "等待上游连线",
};

/** A connection point that takes part in normal layout.
 *
 *  React Flow ships handles as `position: absolute` with a negative offset, so
 *  they hang off the card edge by design. Overriding that puts the dot back in
 *  the row beside its label, where it reads as part of the line rather than as
 *  something stuck to the outside of the card. */
function inlineHandle(dot: string, ring: string): CSSProperties {
  return { background: dot, border: `2px solid ${ring}` };
}

/** A node is a card with one row per port, each row carrying its own handle.
 *  That is the whole point of the design: a wire lands on a PARAMETER, not on
 *  a box, so the two ends have schemas to compare. */
function EndpointNode({ data, selected }: NodeProps) {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const { token } = theme.useToken();
  const { flowNode, ports, subtitle, runStatus } = data as NodeData;
  const inputs = ports.filter((p) => p.direction === "in");
  const outputs = ports.filter((p) => p.direction === "out");
  const status = runStatus ? getRunStatusStyle(palette)[runStatus] ?? { color: token.colorTextQuaternary, label: runStatus } : null;
  return (
    <div
      className={`flow-canvas-node flow-type-${flowNode.type} flow-status-${runStatus ?? 'idle'}${selected ? ' is-selected' : ''}`}
      aria-label={`${flowNode.label || FLOW_NODE_TYPE_LABELS[flowNode.type]}${status ? ` · ${status.label}` : ''}`}
      style={{
        // Bounded, not fixed. Content-sized alone let a long node name stretch
        // the card to ~340px; a hard 220px went the other way and left a node
        // with one short port mostly empty. Both ends need a limit.
        minWidth: 210,
        maxWidth: 300,
        borderRadius: 12,
        // A running node outranks a selected one for the border: which node the
        // runner is on right now is news, which node you last clicked is not.
        border: `${runStatus === 'running' ? 2 : 1}px solid ${status ? status.color : selected ? token.colorPrimary : token.colorBorder}`,
        background: runStatus === 'running' ? token.colorInfoBg : token.colorBgContainer,
        boxShadow: selected ? `0 0 0 2px ${token.colorPrimaryBg}` : "0 1px 4px rgba(0,0,0,.08)",
        fontSize: 12,
      }}
    >
      <div
        style={{
          padding: '12px',
          background: token.colorFillQuaternary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: "8px 8px 0 0",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 6,
        }}
      >
        {/* The same glyph the picker showed when this node was chosen. A card
            whose type is only readable as a word means scanning a graph is
            reading, and the three mirrored pairs (入/出参, 分支/汇合,
            逐项/收集) are exactly what a reader wants to spot at a glance. */}
        <span className={`flow-library-icon flow-type-${flowNode.type}`}>
          <NodeIcon type={flowNode.type} size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ fontSize: 12, display: "block" }}>
            {flowNode.label || FLOW_NODE_TYPE_LABELS[flowNode.type]}
          </Typography.Text>
          {/* What this node is bound to. Without it every book node reads
              "Book" and the graph cannot be understood without opening each
              card one at a time. */}
          {subtitle && (
            <Typography.Text ellipsis style={{ fontSize: 11, display: "block", color: token.colorTextTertiary }}>
              {subtitle}
            </Typography.Text>
          )}
        </div>
        {status && (
          <span style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0, color: status.color, fontSize: 10 }}>
            {runStatus === 'running' ? <LoadingOutlined className='flow-running-spinner' /> : runStatus === 'success' || runStatus === 'succeeded' ? <CheckCircleFilled /> : runStatus === 'failed' ? <CloseCircleFilled /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.color }} />}
            {status.label}
          </span>
        )}
        {!status && flowNode.label && (
          <Tag style={{ margin: 0, fontSize: 10, lineHeight: "16px", flexShrink: 0 }}>
            {FLOW_NODE_TYPE_LABELS[flowNode.type]}
          </Tag>
        )}
      </div>

      <div style={{ padding: "2px 0" }}>
      {inputs.map((port) => (
        // The dot is laid out IN the row, as a flex sibling of its label —
        // not absolutely positioned off the card edge. React Flow only needs a
        // handle to have a resolvable box to draw a wire from, so opting out of
        // its default `position: absolute` costs nothing and stops every dot
        // floating free of the line it belongs to.
        <div key={port.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px" }}>
          <Handle type="target" position={Position.Left} id={port.id} className="bcp-flow-handle" style={inlineHandle(token.colorPrimary, token.colorBgContainer)} />
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {port.label}
            {port.required && <span style={{ color: token.colorError }}> *</span>}
            <PortType schema={port.schema} />
          </span>
        </div>
      ))}
      {inputs.length > 0 && outputs.length > 0 && <div style={{ borderTop: `1px dashed ${token.colorBorderSecondary}` }} />}
      {outputs.map((port) => (
        <div key={port.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px" }}>
          <span style={{ flex: 1, minWidth: 0, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {port.kind === "artifact" && <span style={{ color: token.colorTextQuaternary }}>文件 </span>}
            {port.label}
            <PortType schema={port.schema} />
          </span>
          <Handle type="source" position={Position.Right} id={port.id} className="bcp-flow-handle" style={inlineHandle(token.colorSuccess, token.colorBgContainer)} />
        </div>
      ))}
      </div>
      {ports.length === 0 && (
        <div style={{ padding: "8px 10px", color: token.colorTextTertiary, lineHeight: 1.5 }}>{EMPTY_HINT[flowNode.type]}</div>
      )}
    </div>
  );
}

export const nodeTypes = { endpoint: EndpointNode };

export function getLevelColor(p: ReturnType<typeof getPalette>): Record<Compat["level"], string> { return {
  ok: p.ok,
  warn: p.warn,
  unsupported: p.warn,
  error: p.bad,
}; }

export interface EdgeData extends Record<string, unknown> {
  executing?: boolean;
  kind?: "data" | "order";
  srcPath?: string;
  verdict?: Compat;
}

/**
 * A wire that can explain itself.
 *
 * The four-state judgement used to survive only as a stroke colour decided at
 * connect time — which meant the REASON was computed and thrown away, and that
 * an orange wire told you something was off without telling you what. Worse,
 * reloading the page lost even the colour, because the graph came back from
 * storage with no verdict attached. Both follow from treating the verdict as a
 * one-off side effect instead of as something derived from the ports, so it is
 * derived from the ports now, on every render, and the badge is where the
 * reason lands.
 */
function CompatEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps) {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const edgeData = data as EdgeData | undefined;
  const verdict = edgeData?.verdict;
  const order = edgeData?.kind === "order";
  const executing = edgeData?.executing;
  const color = executing ? palette.info : order ? palette.ink3 : getLevelColor(palette)[verdict?.level ?? "ok"];
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={executing ? 'flow-executing-edge' : undefined} style={{ stroke: color, strokeWidth: executing ? 3 : 1.5, ...(executing ? { strokeDasharray: '8 5' } : order ? { strokeDasharray: '4 4' } : {}) }} />
      {verdict && verdict.level !== "ok" && (
        <EdgeLabelRenderer>
          <div style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }} className="nodrag nopan">
            <Tooltip
              title={
                <>
                  {verdict.at ? `${verdict.at}：` : ""}
                  {verdict.reason}
                  {/* The evidence lives here rather than in the sentence: a dozen
                      keyword names is longer than the explanation, and the wire
                      you are pointing at is the only place they apply. */}
                  {verdict.detail && <div style={{ marginTop: 4, opacity: 0.75 }}>{verdict.detail}</div>}
                </>
              }
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: color,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "help",
                }}
              >
                !
              </span>
            </Tooltip>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { compat: CompatEdge };

export function LegendDash({ color, dashed }: { color: string; dashed?: boolean }) {
  return <span style={{ display: "inline-block", width: 14, height: 0, verticalAlign: "middle", marginRight: 3, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }} />;
}
