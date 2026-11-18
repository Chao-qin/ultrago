import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  Handle,
  Panel,
  Position,
  addEdge,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/** Connection points: laid out in the flow, but they still have to LOOK
 *  draggable.
 *
 *  Positioning lives here rather than inline because an inline `transform`
 *  cannot be overridden by `:hover`, and the grow-on-hover is most of what
 *  tells someone the dot is a handle rather than a bullet. The 9px dot keeps a
 *  23px invisible grab area — pulling a wire out of a 9px target is fiddly
 *  enough to read as "connecting doesn't work". */
const HANDLE_CSS = `
.bcp-flow-handle {
  position: relative !important;
  left: 0 !important;
  right: 0 !important;
  top: 0 !important;
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  box-sizing: border-box;
  border-radius: 50%;
  transform: none;
  cursor: crosshair;
  transition: transform .12s ease, box-shadow .12s ease;
}
.bcp-flow-handle:hover {
  transform: scale(1.75);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--c-accent) 22%, transparent);
}
.bcp-flow-handle::after {
  content: "";
  position: absolute;
  inset: -7px;
  border-radius: 50%;
}`;

/** Rows in the problem popover. They are clickable — the whole point is to take
 *  you to the offending node — so they need the hover affordance a plain div
 *  does not have, and a hover rule cannot be written inline. */
const PROBLEM_CSS = `
.bcp-problem-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 5px 6px;
  border-radius: 4px;
  line-height: 20px;
}
.bcp-problem-row:hover { background: rgba(255, 255, 255, .05); }`;

const INSPECTOR_CSS = `
.bcp-flow-inspector { position: relative; }
@media (max-width: 768px) {
  .bcp-flow-inspector {
    position: fixed !important;
    inset: 0 0 0 auto;
    z-index: 1000;
    width: min(100vw, 420px) !important;
    max-width: 100vw;
    box-shadow: -8px 0 28px rgba(0, 0, 0, .16);
  }
}`;
import { Button, Divider, Drawer, Input, Popover, Segmented, Space, Tabs, Tag, Tooltip, Typography, message, theme } from 'antd';
import { PlusOutlined, DeleteOutlined, CloseCircleFilled, ExclamationCircleFilled, LinkOutlined } from '@ant-design/icons';
import { api } from "../lib/api";
import { booksQueryKey } from "../lib/books";
import { dropEdgesForGonePorts, matchingConnections, mintPortId, newNodeConfig, resolvePortsClient, schemaLookup, withFrozenPortIds } from "../lib/flow-ports-client";
import { checkOutputConsumption } from '@bcp/shared';
import { BRANCH_OPERATORS, BRANCH_OPERATOR_LABELS, checkSchemaContract, isUnaryBranchOperator, FLOW_NODE_TYPE_LABELS, SCHEMA_KINDS, SCHEMA_KIND_LABELS, SCRIPT_LANGUAGES, SCRIPT_LANGUAGE_LABELS, connectedInputs, deriveInputSchema, flowInputParams, flowInputPortId, isAssignable, parseFlowGraph, transformOutputKey, validateGraphShape, validatePorts } from "../lib/types";
import type { BranchCase, BranchNodeConfig, MergeNodeConfig, ScriptDryRunResult, ScriptNodeConfig } from "../lib/types";
import type { Compat, FlowEdge, FlowGraph, FlowNode, FlowNodeType, FlowPort, FlowProblem, SchemaRow } from "../lib/types";
import { portTypeLabel } from "@bcp/shared";
import { NodeIcon } from "../components/NodeIcon";
import { NodePicker } from "../components/NodePicker";
import { FlowHeader } from "../components/FlowHeader";
import { FlowTriggerDialog } from '../components/flow-trigger-dialog';
import { FlowExecutionPanel, FlowNodeLibrary } from '../components/flow-workbench-panels';
import { aggregateNodeStatuses, isExecutingEdge } from '../lib/flow-execution';
import './flow-workbench.css';
import { BcpSelect } from "../components/BcpSelect";
import {
  ArrayItemTypeSelect,
  FieldTypeSelect,
  PARAM_TYPES,
  SchemaDetailsDrawer,
  SchemaFieldMeta,
  SchemaPropertiesPreview,
  SchemaRefSelect,
  SchemaRegisterModal,
  isArrayField,
  schemaCitationLabel,
  schemaForCitation,
  schemaSummary,
} from "../components/SchemaSelect";
import type { FlowInputNodeConfig, FlowOutputNodeConfig, ParamMap, ParamSchemaFragment, ParamSpec, SchemaKind, TransformOutput } from "@bcp/shared";
import { constantProblems, constantsOf, paramsOfSchema, subtitleOf, toReactFlowEdge, withConfig, withConstant } from "../lib/flow-editor-model";
import { getLevelColor, LegendDash, PortType, edgeTypes, nodeTypes } from '../components/FlowCanvasNodes';
import type { EdgeData, NodeData } from "../components/FlowCanvasNodes";
import { FlowInputContract, FlowOutputContract, InheritedContract, ScriptInputContract, ScriptOutputContract } from "../components/FlowContractEditors";
import { ScriptBody } from "../components/FlowScriptPanel";
import { BranchCasesEditor, ConstantField, MergeInputsEditor, TransformOutputEditor } from "../components/FlowNodeConfigEditors";
import { useTheme, getPalette } from "../theme";

/** Node types whose failure is a real runtime event worth a recovery policy —
 *  they drive a browser, spawn a process, or loop over items that do. The rest
 *  are synchronous computation that cannot fail for external reasons. */
const FAILABLE_NODE_TYPES: FlowNodeType[] = ["book", "script", "map"];

const PALETTE: FlowNodeType[] = ["flowInput", "book", "script", "transform", "branch", "merge", "map", "collect", "flowOutput"];

export function FlowEditor() {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { token } = theme.useToken();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState("props");
  const [dirty, setDirty] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "node" | "edge"; id: string } | null>(null);
  const [triggering, setTriggering] = useState(false);
  const triggerInFlight = useRef(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [rf, setRf] = useState<ReactFlowInstance<Node<NodeData>, Edge> | null>(null);
  const [mutationErrors, setMutationErrors] = useState<string[]>([]);
  /** The canvas picker, and where the node it produces should land. Both the
   *  screen point (to put the panel under the cursor) and the flow point (to
   *  put the NODE under the cursor), because the canvas is panned and zoomed
   *  and the two stop agreeing the moment anyone scrolls. */
  const [canvasPicker, setCanvasPicker] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  const [batchTarget, setBatchTarget] = useState<string>();
  /** Which flow's graph the canvas is currently holding. */
  const loaded = useRef<string | null>(null);

  const flow = useQuery({ queryKey: ["flow", id], queryFn: () => api.getFlow(id), enabled: !!id });
  // Key mirrors the Books page's default view (includeDeleted) — same idea as
  // the schemas key below, except books own theirs in lib/books.ts.
  const books = useQuery({ queryKey: booksQueryKey(false), queryFn: () => api.listBooks({ includeDeleted: false }) });
  // Key mirrors the Schemas page's default view (kind / includeInactive /
  // includeDeleted) so both share one cache entry for the same request.
  // Keep retired versions in the editor cache so a historical citation can be
  // displayed and replaced instead of looking broken after a new version lands.
  const schemas = useQuery({ queryKey: ["schemas", undefined, true, false], queryFn: () => api.listSchemas({ includeInactive: true }) });
  // The other flows, for subflow nodes. Same key the flow list page uses, so
  // both share one cache entry rather than fetching the same list twice.
  const flows = useQuery({ queryKey: ["flows", false], queryFn: () => api.listFlows({ includeDeleted: false }) });

  /** The graph as the rest of the app understands it, rebuilt from canvas state. */
  const graph: FlowGraph = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...(n.data as NodeData).flowNode, position: n.position })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? "",
        target: e.target,
        targetHandle: e.targetHandle ?? "",
        ...((e.data as { kind?: "data" | "order" })?.kind ? { kind: (e.data as { kind: "data" | "order" }).kind } : {}),
        ...((e.data as { srcPath?: string })?.srcPath ? { srcPath: (e.data as { srcPath: string }).srcPath } : {}),
      })),
    }),
    [nodes, edges],
  );

  const ports = useMemo(
    () => resolvePortsClient(graph, books.data ?? [], schemas.data ?? [], flows.data ?? []),
    [graph, books.data, schemas.data, flows.data],
  );

  /** The latest run, polled while it is still moving so the canvas can show
   *  where the runner is. Editing does not stop the poll — seeing the previous
   *  run's outcome on the graph you are changing is exactly the context you
   *  want while fixing it. */
  const runs = useQuery({
    queryKey: ["flow-runs", id],
    queryFn: () => api.listFlowRuns(id),
    enabled: !!id,
    // Slow, because this only has to NOTICE a run — triggering from this page
    // invalidates it directly, so the interval is here for runs a schedule
    // started. Following one once it exists is the detail query's job.
    refetchInterval: 10000,
  });
  const latestRunId = runs.data?.[0]?.id;
  const latestRun = useQuery({
    queryKey: ["flow-run", latestRunId],
    queryFn: () => api.getFlowRun(latestRunId!),
    enabled: !!latestRunId,
    refetchInterval: (q) => (!q.state.data || ['pending', 'queued', 'running', 'paused'].includes(q.state.data.status) ? 1500 : false),
  });
  const nodeStatus = useMemo(() => {
    return aggregateNodeStatuses(latestRun.data?.nodes ?? []);
  }, [latestRun.data]);

  /**
   * Load a flow's graph once per flow; afterwards the canvas owns the state.
   *
   * Keyed on the flow ID, not on a plain "have I loaded yet" flag. Opening a
   * second flow reuses this component — same route, different param — so with a
   * boolean the canvas kept the FIRST flow's nodes while the toolbar showed the
   * second one's name and the save button stayed armed. Saving from there wrote
   * one flow's graph over another's.
   */
  useEffect(() => {
    if (!flow.data || flow.data.id !== id || loaded.current === id
      || !books.isSuccess || !schemas.isSuccess || !flows.isSuccess) return;
    loaded.current = id;
    const parsed = parseFlowGraph(flow.data.graphJson);
    // React Flow removes an edge whose handle is absent on its first render.
    // Restoring edges alongside nodes with ports:[] therefore erased every
    // persisted wire before the later port-resolution effect could add handles.
    // Hydrate ports before mounting either side of a restored connection.
    const restoredNodes = parsed.nodes.map(withFrozenPortIds);
    const restoredPorts = resolvePortsClient(
      { ...parsed, nodes: restoredNodes },
      books.data ?? [],
      schemas.data ?? [],
      flows.data ?? [],
    );
    setNodes(
      restoredNodes.map((n) => ({
        id: n.id,
        type: "endpoint",
        position: n.position,
        data: { flowNode: n, ports: restoredPorts.get(n.id) ?? [] } as NodeData,
      })),
    );
    setEdges(parsed.edges.map(toReactFlowEdge));
    const requestedNode = searchParams.get("node");
    setSelected(requestedNode && parsed.nodes.some((node) => node.id === requestedNode) ? requestedNode : null);
    const requestedTab = searchParams.get("tab");
    setInspectorTab(requestedTab === "io" || requestedTab === "inputs" ? requestedTab : "props");
    setDirty(false);
    history.current = { past: [], future: [] };
  }, [id, flow.data, searchParams, books.data, books.isSuccess, schemas.data,
    schemas.isSuccess, flows.data, flows.isSuccess, setNodes, setEdges]);

  const bookNames = useMemo(() => new Map((books.data ?? []).map((b) => [b.id, b.name])), [books.data]);

  // Ports, identity and run status are all DERIVED, so they are pushed back
  // onto the nodes for rendering rather than stored in the graph.
  useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        const resolved = ports.get(n.id) ?? [];
        const data = n.data as NodeData;
        const subtitle = subtitleOf(data.flowNode, bookNames, books.isSuccess);
        const runStatus = nodeStatus.get(n.id);
        if (data.ports === resolved && data.subtitle === subtitle && data.runStatus === runStatus) return n;
        return { ...n, data: { ...data, ports: resolved, subtitle, runStatus } };
      }),
    );
  }, [ports, bookNames, books.isSuccess, nodeStatus, setNodes]);

  /** Undo, built on whole-canvas snapshots.
   *
   *  A snapshot is taken BEFORE each change that a person would call a step —
   *  add, delete, connect, edit a field, start a drag — which is why dragging a
   *  node across the canvas is one undo rather than four hundred.
   *
   *  The live canvas is mirrored into a ref because the snapshot has to be of
   *  what is on screen at the moment of the click, and a callback that closes
   *  over `nodes` captures whatever the last render saw. That exact mistake
   *  once made every freshly added node land on the same coordinates. */
  const live = useRef({ nodes, edges });
  live.current = { nodes, edges };
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const [, bumpHistory] = useState(0);

  const pushHistory = useCallback(() => {
    history.current.past.push({ ...live.current });
    if (history.current.past.length > 50) history.current.past.shift();
    history.current.future = [];
    bumpHistory((n) => n + 1);
  }, []);

  const step = useCallback(
    (from: "past" | "future") => {
      const target = history.current[from].pop();
      if (!target) return;
      history.current[from === "past" ? "future" : "past"].push({ ...live.current });
      setNodes(target.nodes);
      setEdges(target.edges);
      setDirty(true);
      bumpHistory((n) => n + 1);
    },
    [setNodes, setEdges],
  );

  /** The two ports a wire actually lands on, or `undefined` where there is no
   *  longer a port of that name — which is a different question from "are the
   *  contracts compatible" and is asked on its own by `strandedEdges` below. */
  const endpointsOf = useCallback(
    (c: Connection | Edge | FlowEdge) => ({
      source: ports.get(c.source)?.find((p) => p.id === c.sourceHandle && p.direction === "out"),
      target: ports.get(c.target)?.find((p) => p.id === c.targetHandle && p.direction === "in"),
    }),
    [ports],
  );

  const compatOf = useCallback(
    (c: Connection | Edge): Compat => {
      const { source, target } = endpointsOf(c);
      if (!source || !target) return { level: "error", reason: "端口不存在" };
      return isAssignable(source.schema, target.schema);
    },
    [endpointsOf],
  );

  /** Wires whose handles no longer exist.
   *
   *  React Flow cannot draw one — there is no dot to anchor it to — so it is
   *  not on the canvas to right-click, not selectable to press Delete on, and
   *  not reachable by any other route: without the button the problem list now
   *  grows, its error would sit on the flow forever and keep 触发 disabled.
   *  Renaming a port no longer creates these (see `patchNodeConfig`), but
   *  rebinding a Book or swapping a cited schema still can. */
  const strandedEdges = useMemo(
    () =>
      new Set(
        graph.edges
          .filter((e) => {
            const { source, target } = endpointsOf(e);
            return !source || !target;
          })
          .map((e) => e.id),
      ),
    [graph.edges, endpointsOf],
  );

  /** Only a PROVABLE mismatch is refused. A warning or an unjudgeable schema
   *  still connects — the runtime checks it for real, and blocking here would
   *  push people into deleting their contracts to get work done. */
  const isValidConnection = useCallback((c: Edge | Connection) => compatOf(c).level !== "error", [compatOf]);

  const onConnect = useCallback(
    (c: Connection) => {
      const verdict = compatOf(c);
      if (verdict.level === "error") {
        message.error(verdict.reason);
        return;
      }
      pushHistory();
      setDirty(true);
      setEdges((eds) => addEdge({ ...c, data: { kind: "data" } }, eds));
    },
    [compatOf, setEdges, pushHistory],
  );

  /** Edges as they are DRAWN: the stored edge plus a verdict recomputed from
   *  the current ports. Kept separate from `edges` so the graph that gets saved
   *  stays free of derived data, and so a verdict can never go stale — change a
   *  book binding and every wire touching it is re-judged on the next render. */
  const displayEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: "compat",
        data: { ...(e.data as EdgeData), verdict: compatOf(e), executing: isExecutingEdge(e.source, e.target, nodeStatus) },
      })),
    [edges, compatOf, nodeStatus],
  );

  const addNode = (type: FlowNodeType, dropAt?: { x: number; y: number }) => {
    const nodeId = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    pushHistory();
    // The position is computed INSIDE the updater, from the list React is about
    // to update. Reading `nodes.length` from the enclosing scope looks
    // equivalent and is not: React batches state updates, so adding several
    // nodes before a re-render made every one of them read length 0 and land on
    // the same coordinates, stacked in a pile.
    let landed = { x: 60, y: 60 };
    setNodes((cur) => {
      // A flow reads left to right, so a new node goes to the RIGHT of
      // everything already there, level with the topmost card. The old 3-wide
      // grid put the fourth node underneath the first, which turned a chain
      // people were drawing left-to-right into a zigzag they had to untangle by
      // hand before they could wire anything.
      // A node asked for AT a point lands there — right-clicking empty canvas
      // and getting the node somewhere else is the interaction failing at the
      // one thing it promised.
      landed = dropAt
        ? dropAt
        : cur.length === 0
          ? { x: 60, y: 60 }
          : { x: Math.max(...cur.map((n) => n.position.x)) + 340, y: Math.min(...cur.map((n) => n.position.y)) };
      const flowNode: FlowNode = {
        id: nodeId,
        type,
        position: landed,
        config: newNodeConfig(type),
      };
      return [...cur, { id: nodeId, type: "endpoint", position: landed, data: { flowNode, ports: [] } }];
    });
    setSelected(nodeId);
    setDirty(true);
    // Chaining rightwards walks off the screen within a few nodes, and a node
    // you cannot see reads as a node that was never added. Centring has to wait
    // for the frame in which the inspector column mounts, because selecting the
    // new node narrows the canvas — centre against the old width and the node
    // lands under the panel that just appeared.
    // Only when the canvas chose the spot. Recentring on a node the author
    // just placed by hand yanks the view out from under them.
    if (!dropAt) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => rf?.setCenter(landed.x + 150, landed.y + 90, { zoom: rf.getZoom(), duration: 250 }));
      });
    }
  };

  const patchNode = (nodeId: string, patch: Partial<FlowNode>) => {
    pushHistory();
    setNodes((cur) =>
      cur.map((n) => (n.id === nodeId ? { ...n, data: { ...(n.data as NodeData), flowNode: { ...(n.data as NodeData).flowNode, ...patch } } } : n)),
    );
    setDirty(true);
  };

  /** Write a config whose rows ARE PORTS, and take the deleted ones' wires
   *  with them.
   *
   *  Renaming needs nothing here — that is what `portId` bought. Deleting still
   *  does: the port goes, and a wire left on it would be invisible on the
   *  canvas and fatal on every save. Both state updates ride one `pushHistory`,
   *  because the deletion and the wires that went with it are one thing that
   *  happened, so they are one undo. */
  const patchNodeConfig = (node: FlowNode, config: FlowNode["config"]) => {
    patchNode(node.id, { config });
    const portIds = (c: FlowNode["config"]): string[] =>
      node.type === "flowInput"
        ? ((c as FlowInputNodeConfig).params ?? []).map(flowInputPortId)
        : ((c as { outputs?: TransformOutput[] }).outputs ?? []).map((o) => o.id);
    if (node.type === "flowInput" || node.type === "transform") {
      setEdges((cur) => dropEdgesForGonePorts(cur, node.id, portIds(node.config), portIds(config)));
    }
  };

  /** Removing a node must take its wires with it. React Flow's change handler
   *  applies the node removal but leaves edges pointing at a node that no
   *  longer exists, and a dangling edge fails validation on save with a message
   *  about a node nobody can see. */
  const deleteNode = useCallback(
    (nodeId: string) => {
      pushHistory();
      setNodes((cur) => cur.filter((n) => n.id !== nodeId));
      setEdges((cur) => cur.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelected((cur) => (cur === nodeId ? null : cur));
      setMenu(null);
      setDirty(true);
    },
    [setNodes, setEdges, pushHistory],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      pushHistory();
      setEdges((cur) => cur.filter((e) => e.id !== edgeId));
      setMenu(null);
      setDirty(true);
    },
    [setEdges, pushHistory],
  );

  /**
   * Everything wrong with the graph ON SCREEN, recomputed as you edit.
   *
   * These are the same two functions the server runs on save — the only
   * difference is where the books and schemas are looked up. Running them here
   * is what stops the banner from describing a graph nobody is looking at: it
   * used to merge local shape checks against the live canvas with port checks
   * the server had performed against the SAVED graph, so an unsaved canvas
   * could be reported as flawless while the saved one was empty, and the two
   * halves of the banner could contradict each other outright.
   */
  const liveProblems = useMemo(
    () => [
      ...validateGraphShape(graph),
      ...validatePorts(graph, ports),
      ...graph.nodes.flatMap((node) => checkOutputConsumption(graph, node, ports)),
      ...fieldSchemaRefProblems(graph, schemas.data ?? []),
      ...constantProblems(graph, ports),
    ],
    [graph, ports, schemas.data],
  );

  /** `node::port` for every input a wire lands on, which is what decides
   *  whether the inspector offers a constant for it. */
  const wiredInputs = useMemo(() => connectedInputs(graph), [graph]);

  /** Annotated rather than inferred: a mutation failure has no `at`, and left
   *  to inference the union has no such property at all — which would put the
   *  problem list's "take me to it" out of reach for every entry, not just the
   *  ones that genuinely point nowhere. */
  const allProblems = useMemo<FlowProblem[]>(
    () => [
      ...liveProblems,
      ...mutationErrors.map((msg) => ({ level: "error" as const, message: msg })),
    ],
    [liveProblems, mutationErrors],
  );

  const save = useMutation({
    mutationFn: () => api.updateFlow(id, { graphJson: JSON.stringify(graph), expectedUpdatedAt: flow.data?.updatedAt }),
    onSuccess: async () => {
      setDirty(false);
      message.success("已保存");
      await qc.invalidateQueries({ queryKey: ["flow", id] });
      const server = await api.validateFlow(id);
      // The server is the authority, so a disagreement with the canvas is news
      // rather than noise — it means the two resolved a book or a schema
      // differently, and only the server's answer is the one that runs.
      const unseen = server.problems.filter((p) => !liveProblems.some((l) => l.message === p.message));
      if (unseen.length > 0) message.warning(`服务端校验另有 ${unseen.length} 条：${unseen[0].message}`);
    },
    onError: (e: Error & { status?: number }) => {
      const detail = e.status === 409 ? "流程已被其它窗口修改，请重新加载服务器版本后再保存" : `保存失败：${e.message}`;
      setMutationErrors((prev) => [...prev, detail]);
      message.error(detail);
    },
  });

  /** The server's own opinion, on demand. Only reachable when the canvas and
   *  the stored graph are the same thing, so its answer can no longer be about
   *  a different graph than the one being looked at. */
  const serverCheck = useMutation({
    mutationFn: () => api.validateFlow(id),
    onSuccess: (r) =>
      r.problems.length === 0
        ? message.success("服务端校验通过")
        : message.warning(`服务端校验：${r.problems.length} 条 —— ${r.problems[0].message}`),
    onError: (e: Error) => { setMutationErrors((prev) => [...prev, `服务端校验失败：${e.message}`]); },
  });

  const trigger = useMutation({
    mutationFn: (params: ParamMap) => api.triggerFlow(id, params),
    onSuccess: (run) => {
      setTriggering(false);
      message.success(`已触发，运行 ${run.id.slice(0, 8)}`);
      qc.invalidateQueries({ queryKey: ["flow-runs", id] });
      navigate(`/flow-runs/${run.id}`);
    },
    onError: (e: Error) => { setMutationErrors((prev) => [...prev, `触发失败：${e.message}`]); },
    onSettled: () => { triggerInFlight.current = false; },
  });

  const errors = allProblems.filter((p) => p.level === "error");
  /* `unsupported` is split out rather than listed: it fires once per wire that
     touches a schema the canvas cannot read, so a flow whose output contract
     uses `$ref` produces the same sentence on every wire into it — three
     identical paragraphs burying the one required input that is actually
     missing. The wire already carries the colour and the tooltip, so the list
     only needs to say how many there are. */
  const warnings = allProblems.filter((p) => p.level === "warn");
  const deferred = allProblems.filter((p) => p.level === "unsupported");

  /**
   * Which nodes a problem points at: the node itself, or both endpoints of the
   * edge, because an incompatible wire is only readable with the two shapes it
   * joins in view.
   *
   * Filtered against the graph rather than trusted, because the loudest reason
   * an edge gets reported at all is that one of its endpoints is MISSING
   * ("连线指向不存在的起点节点"). Handing those ids to fitView asks it to frame
   * nodes that do not exist, and empty bounds do not read as "nothing to do" —
   * they read as a viewport jump to nowhere, which on a canvas is indisinguishable
   * from having lost the graph.
   */
  const targetsOf = useCallback(
    (at: string | undefined): string[] => {
      if (!at) return [];
      if (graph.nodes.some((n) => n.id === at)) return [at];
      const edge = graph.edges.find((e) => e.id === at);
      if (!edge) return [];
      return [edge.source, edge.target].filter((nodeId) => graph.nodes.some((n) => n.id === nodeId));
    },
    [graph],
  );

  /** Take the canvas to a problem, and stand down if there is nowhere to go —
   *  including leaving the panel open, so a click that cannot move the canvas
   *  does not look like one that did. */
  const locate = useCallback(
    (problem: FlowProblem) => {
      const at = problem.at;
      const ids = targetsOf(at);
      if (ids.length === 0 || !rf) return;
      if (ids.length === 1 && ids[0] === at) setSelected(at);
      if (problem.tab) setInspectorTab(problem.tab);
      rf.fitView({ nodes: ids.map((nodeId) => ({ id: nodeId })), duration: 300, maxZoom: 1.2, padding: 0.4 });
      setProblemsOpen(false);
    },
      [rf, targetsOf],
  );

  const selectedNode = nodes.find((n) => n.id === selected)?.data as NodeData | undefined;
  const batchTargets = useMemo(
    () => nodes.filter((n) => n.id !== selected).map((n) => ({ value: n.id, label: (n.data as NodeData).flowNode.label || FLOW_NODE_TYPE_LABELS[(n.data as NodeData).flowNode.type] })),
    [nodes, selected],
  );
  const connectMatching = useCallback(() => {
    if (!selected || !batchTarget) return;
    const connections = matchingConnections(selected, batchTarget, ports, edges);
    if (connections.length === 0) {
      message.info("没有找到可新增的同名兼容字段");
      return;
    }
    pushHistory();
    setEdges((current) => connections.reduce((next, connection) => addEdge({ ...connection, data: { kind: "data" } }, next), current));
    setDirty(true);
    message.success(`已批量连接 ${connections.length} 个字段`);
  }, [batchTarget, edges, ports, pushHistory, selected, setEdges]);
  const inputSpecs = useMemo(
    // Same lookup the flowInput panel and the canvas ports use: a node that
    // cites the registry must ask the trigger dialog for the cited fields.
    () => deriveInputSchema(graph, schemaLookup(schemas.data ?? [])),
    [graph, schemas.data],
  );

  /** Losing an unsaved canvas is losing work, so both ways out ask first. */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const leave = () => {
    if (dirty && !window.confirm("有未保存的改动，离开会丢失。确定离开吗？")) return;
    navigate("/flows");
  };

  // Undo/redo. React Flow owns Delete/Backspace; these are the other two keys
  // people try without being told about them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement | null;
      // Inside a text field Ctrl+Z means "undo my typing", which the browser
      // already does better than a canvas-wide snapshot ever could.
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      e.preventDefault();
      step(e.shiftKey ? "future" : "past");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  return (
    <div className='flow-workbench' data-theme={mode} style={{ '--flow-surface': token.colorBgContainer, '--flow-elevated': token.colorBgElevated, '--flow-text': token.colorText, '--flow-muted': token.colorTextSecondary, '--flow-border': token.colorBorderSecondary, '--flow-accent': token.colorPrimary, '--flow-tint': token.colorPrimaryBg } as CSSProperties}>
      <style>{HANDLE_CSS}{PROBLEM_CSS}{INSPECTOR_CSS}</style>
      <FlowHeader
        flowName={flow.data?.name ?? ""}
        dirty={dirty}
        onBack={leave}
        history={{
          canUndo: history.current.past.length > 0,
          canRedo: history.current.future.length > 0,
          onUndo: () => step("past"),
          onRedo: () => step("future"),
        }}
        onAddNode={(anchor) =>
          setCanvasPicker({
            screen: { x: anchor.left, y: anchor.bottom + 4 },
            // Dropped in the middle of the canvas rather than under the cursor:
            // a node added from the toolbar has no meaningful place the pointer
            // was pointing at.
            flow: rf?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 60, y: 60 },
          })
        }
        save={{
          run: () => save.mutate(),
          pending: save.isPending,
          blocked: !dirty || errors.length > 0,
          blockedReason: errors.length > 0 ? "先修复问题面板中的错误" : undefined,
        }}
        /* 校验 and 触发 both act on the SAVED graph, so both are closed while the
           canvas differs from it. Leaving them open is how "已触发" came to be
           reported for a run of a graph that was not the one on screen. */
        trigger={{
          run: () => setTriggering(true),
          pending: trigger.isPending,
          blocked: !flow.data?.enabled || dirty || errors.length > 0,
          blockedReason: !flow.data?.enabled ? '流程已停用' : dirty ? "画布有未保存的改动，先保存再触发" : errors.length > 0 ? "先修掉错误" : "填入流程参数并运行",
        }}
        check={{
          run: () => serverCheck.mutate(),
          pending: serverCheck.isPending,
          blocked: dirty,
          blockedReason: dirty ? "画布有未保存的改动；校验与触发都作用于已保存的图，先保存" : "让服务端再核一遍已保存的图",
        }}
        onOpenRuns={() => { if (!dirty || window.confirm("有未保存的改动，离开会丢失。确定离开吗？")) navigate(`/flow-runs?flowId=${id}`); }}
      >
        {/* Problems used to be a full-width banner above the canvas. Six of them
            wrapped to nine lines and ate close to half the viewport, which is
            the wrong trade for a canvas: the thing you need to see in order to
            fix a problem is the graph. As a toolbar pill the count is always
            visible, the detail is one click away, and clicking a row flies the
            canvas to the node instead of leaving you to hunt for it. Errors
            still stop a trigger — 触发 above is disabled and says why. */}
        {allProblems.length > 0 && (
          <Popover
            trigger="click"
            placement="bottomLeft"
            // Controlled so that locating a problem can dismiss it: the panel
            // opens over the canvas, so leaving it up after flying to a node
            // hides the very thing the click asked to see.
            open={problemsOpen}
            onOpenChange={setProblemsOpen}
            content={
              <div style={{ width: 380, maxHeight: 320, overflowY: "auto" }}>
                {[...errors, ...warnings].map((p, i) => (
                  <div
                    key={i}
                    className="bcp-problem-row"
                    // The pointer is a promise that the click goes somewhere, so
                    // it is spent on the same test `locate` makes, not on the
                    // weaker "this problem named something".
                    style={{ cursor: rf && targetsOf(p.at).length > 0 ? "pointer" : "default" }}
                    onClick={() => locate(p)}
                  >
                    {p.level === "error" ? (
                      <CloseCircleFilled style={{ color: token.colorError, marginTop: 3 }} />
                    ) : (
                      <ExclamationCircleFilled style={{ color: token.colorWarning, marginTop: 3 }} />
                    )}
                    <span style={{ flex: 1 }}>{p.message}</span>
                    {/* The only way to remove a wire that has nowhere to be
                        drawn. Flying to the node cannot help here — there is
                        nothing to see when you arrive. */}
                    {p.at && strandedEdges.has(p.at) && (
                      <Button
                        size="small"
                        type="link"
                        danger
                        style={{ padding: 0, height: "auto", flexShrink: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteEdge(p.at!);
                        }}
                      >
                        删除这条线
                      </Button>
                    )}
                  </div>
                ))}
                {deferred.length > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      paddingTop: 6,
                      borderTop: `1px solid ${token.colorSplit}`,
                      color: token.colorTextTertiary,
                      fontSize: 12,
                    }}
                  >
                    另有 {deferred.length} 条连线的契约含画布判不了的关键字，运行时才校验 —— 见画布上的黄线与线上的 <b>!</b>
                  </div>
                )}
              </div>
            }
          >
            <Button
              size="small"
              danger={errors.length > 0}
              icon={
                errors.length > 0 ? (
                  <CloseCircleFilled />
                ) : (
                  <ExclamationCircleFilled style={{ color: token.colorWarning }} />
                )
              }
            >
              {[
                errors.length > 0 ? `${errors.length} 错误` : null,
                allProblems.length - errors.length > 0 ? `${allProblems.length - errors.length} 提示` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Button>
          </Popover>
        )}
      </FlowHeader>

      {/* The inspector is a COLUMN beside the canvas, not a sheet over it.
          As an overlay it covered the right 320px, which routinely hid the very
          node you had just added and put its output handles out of reach — you
          could not drag a wire from something the panel was sitting on, and Fit
          View could not help because it fits the container, not the visible
          part of it. */}
      <div className='flow-workbench-body'>
      <FlowNodeLibrary onAdd={addNode} />
      <div className='flow-workbench-center'>
      <div className='flow-canvas'>
        <ReactFlow
          nodes={nodes}
          edges={displayEdges}
          onInit={setRf}
          onNodesChange={(c) => {
            onNodesChange(c);
            if (c.some((ch) => ch.type === "position" || ch.type === "remove")) setDirty(true);
          }}
          onEdgesChange={(c) => {
            onEdgesChange(c);
            if (c.some((ch) => ch.type === "remove")) setDirty(true);
          }}
          // One snapshot per drag, taken when the drag starts — not one per
          // position change, of which a single drag emits hundreds.
          onNodeDragStart={pushHistory}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeClick={(_, n) => {
            setSelected(n.id);
            setMenu(null);
          }}
          onNodeContextMenu={(e, n) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, kind: "node", id: n.id });
          }}
          onEdgeContextMenu={(e, edge) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, kind: "edge", id: edge.id });
          }}
          onPaneClick={() => {
            setMenu(null);
            setCanvasPicker(null);
          }}
          // Right-clicking empty canvas used to do nothing but dismiss. It is
          // where a node gets added now — the same panel the toolbar opens,
          // because "browse what exists" and "I know what I want" are different
          // states of mind and neither replaces the other. The node lands under
          // the cursor.
          onPaneContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
            const ev = e as unknown as MouseEvent;
            setCanvasPicker({
              screen: { x: ev.clientX, y: ev.clientY },
              flow: rf?.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }) ?? { x: 60, y: 60 },
            });
          }}
          onDoubleClick={(e) => {
            // The pane itself only. A double-click that landed on a node or a
            // wire means something else there, and taking the gesture would
            // remove the one people use to rename.
            if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
            setCanvasPicker({
              screen: { x: e.clientX, y: e.clientY },
              flow: rf?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 60, y: 60 },
            });
          }}
          // Both keys, because which one "means delete" depends on the keyboard
          // in front of you. Edge cleanup rides on onNodesDelete so the keyboard
          // path behaves exactly like the menu one.
          deleteKeyCode={["Delete", "Backspace"]}
          // The snapshot has to be taken BEFORE React Flow applies the removal,
          // and onNodesDelete already runs before it — so a Delete keypress is
          // undoable exactly like the menu's 删除, which is the one thing people
          // most want back.
          onBeforeDelete={async () => { pushHistory(); return true; }}
          onNodesDelete={(deleted) => {
            const gone = new Set(deleted.map((n) => n.id));
            setEdges((cur) => cur.filter((e) => !gone.has(e.source) && !gone.has(e.target)));
            setDirty(true);
          }}
          nodeTypes={nodeTypes}
          colorMode={mode}
          edgeTypes={edgeTypes}
          fitView
          // Without a cap, fitView zooms a one- or two-node canvas to 2x. Every
          // padding and font size doubles with it, which reads as a broken
          // layout rather than as "you are zoomed in".
          fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
          minZoom={0.3}
          maxZoom={1.75}
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls fitViewOptions={{ maxZoom: 1, padding: 0.25 }} />
          <MiniMap pannable zoomable />
          {nodes.length === 0 && (
            // An empty canvas that says nothing reads as a canvas that is
            // broken. The toolbar does carry the instructions, but it is at the
            // top of the window and the eye is in the middle of the grid.
            <Panel position="top-center">
              <div style={{ marginTop: 80, textAlign: "center", color: token.colorTextTertiary, lineHeight: 2, pointerEvents: "none" }}>
                <div style={{ fontSize: 15, color: token.colorTextSecondary }}>空白流程</div>
                <div>用上方「添加节点」放第一个节点，通常从「流程入参」开始</div>
                <div>然后从卡片右侧的圆点拖到下一个节点左侧的圆点，把它们连起来</div>
              </div>
            </Panel>
          )}
          <Panel position='top-left' className='flow-canvas-minibar'>
            <section aria-label='画布信息'>
              <span>{nodes.length} 节点 <span className='flow-muted'>·</span> {edges.length} 连线</span>
              <Tooltip title='右键画布添加节点；拖动端口连接；⌘ / Ctrl Z 撤销。' trigger={['hover', 'focus', 'click']}>
                <button type='button' aria-label='画布操作提示'>?</button>
              </Tooltip>
            </section>
          </Panel>
          {edges.length > 0 && (
            <Panel position="top-right" className='flow-canvas-legend'>
              <Space size={10} style={{ background: token.colorBgElevated, padding: "3px 8px", borderRadius: 6, boxShadow: token.boxShadowTertiary, fontSize: 11 }}>
                <span><LegendDash color={getLevelColor(palette).ok} /> 契约相符</span>
                <span><LegendDash color={getLevelColor(palette).warn} /> 有保留，看线上的 <b>!</b></span>
                <span><LegendDash color={palette.ink3} dashed /> 仅顺序</span>
              </Space>
            </Panel>
          )}
        </ReactFlow>

        {canvasPicker && (
          <NodePicker
            at={canvasPicker.screen}
            onPick={(type) => {
              addNode(type, canvasPicker.flow);
              setCanvasPicker(null);
            }}
            onClose={() => setCanvasPicker(null)}
          />
        )}
      </div>
      <FlowExecutionPanel run={latestRun.data} loading={runs.isLoading || latestRun.isLoading} error={runs.isError || latestRun.isError} onLocate={(nodeId) => { setSelected(nodeId); const node = nodes.find((item) => item.id === nodeId); if (node) void rf?.fitView({ nodes: [node], maxZoom: 1, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300 }); }} onOpen={() => { if (latestRunId && (!dirty || window.confirm('有未保存的改动，离开会丢失。确定离开吗？'))) navigate(`/flow-runs/${latestRunId}`); }} />
      </div>

      {menu && (
        <div
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            zIndex: 1100,
            background: token.colorBgElevated,
            borderRadius: 6,
            boxShadow: token.boxShadowSecondary,
            padding: 4,
            minWidth: 132,
          }}
          onMouseLeave={() => setMenu(null)}
        >
          {menu.kind === "node" && (
            <Button type="text" size="small" block style={{ textAlign: "left" }} onClick={() => setSelected(menu.id)}>
              配置此节点
            </Button>
          )}
          <Button
            type="text"
            size="small"
            block
            danger
            icon={<DeleteOutlined />}
            style={{ textAlign: "left" }}
            onClick={() => (menu.kind === "node" ? deleteNode(menu.id) : deleteEdge(menu.id))}
          >
            {menu.kind === "node" ? "删除节点" : "删除连线"}
          </Button>
        </div>
      )}

      {selectedNode && (
        <aside
          className="bcp-flow-inspector"
          aria-label="节点配置面板"
          style={{
            width: 320,
            flexShrink: 0,
            borderLeft: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            overflowY: "auto",
            padding: 16,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Typography.Text strong>{FLOW_NODE_TYPE_LABELS[selectedNode.flowNode.type]}</Typography.Text>
            <Space size={4}>
              <Button danger size="small" icon={<DeleteOutlined />} onClick={() => deleteNode(selectedNode.flowNode.id)}>
                删除
              </Button>
              <Button size="small" type="text" onClick={() => setSelected(null)}>
                收起
              </Button>
           </Space>
          </div>
          <Tabs
            size="small"
            activeKey={inspectorTab}
            onChange={setInspectorTab}
            // 「契约」和「端口」曾经是并列的两个 tab,读起来像两套要分别维护的东西 ——
            // 而端口根本不存在于 FlowNode 上,它是 portsFor() 从契约现算出来的像。
            // 合成一个「接口」:上半声明,下半是声明长出来的结果加上在结果上填值,
            // 中间那行分隔说明它们的因果。
            items={[{ key: "props", label: "属性" }, { key: "io", label: "接口" }]}
            style={{ marginBottom: 8 }}
          />
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            {inspectorTab === "props" && <>
            <div>
              <Typography.Text type="secondary">名称</Typography.Text>
              <Input
                value={selectedNode.flowNode.label ?? ""}
                placeholder={selectedNode.flowNode.id}
                onChange={(e) => patchNode(selectedNode.flowNode.id, { label: e.target.value })}
              />
            </div>

            {/* Only where a failure is both possible and worth surviving. A
                transform or a branch is pure computation over values already in
                hand; offering a recovery policy there would be a control that
                can never do anything. */}
            {FAILABLE_NODE_TYPES.includes(selectedNode.flowNode.type) && (
              <div>
                <Typography.Text type="secondary">失败时</Typography.Text>
                <Segmented
                  size="small"
                  block
                  value={selectedNode.flowNode.onFail ?? "stop"}
                  options={[
                    { label: "停止整条流程", value: "stop" },
                    { label: "跳过继续", value: "continue" },
                  ]}
                  onChange={(value) => patchNode(selectedNode.flowNode.id, { onFail: value as "stop" | "continue" })}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {selectedNode.flowNode.onFail === "continue"
                    ? selectedNode.flowNode.type === "map"
                      ? "某一项失败就跳过它，继续跑剩下的；最后产出里不含失败的那些"
                      : "这个节点失败时，只有依赖它的下游会被跳过，其它分支照常跑完"
                    : "默认：这个节点失败，整条流程就失败"}
                </Typography.Text>
              </div>
            )}

            {selectedNode.flowNode.type === "book" && (
              <div>
                <Typography.Text type="secondary">绑定 Book</Typography.Text>
                <BcpSelect
                  style={{ width: "100%" }}
                  value={(selectedNode.flowNode.config as { bookId?: string }).bookId}
                  options={(books.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
                   onChange={(bookId) => patchNode(selectedNode.flowNode.id, { config: withConfig(selectedNode.flowNode.config, "bookId", bookId) })}
                />
              </div>
            )}

            {selectedNode.flowNode.type === "flow" && (
              <div>
                <Typography.Text type="secondary">运行哪条流程</Typography.Text>
                <BcpSelect
                  style={{ width: "100%" }}
                  placeholder="选一条流程"
                  value={(selectedNode.flowNode.config as { flowId?: string }).flowId}
                  // This flow is not in the list. Embedding itself is infinite
                  // recursion, and `validateSubflows` refuses it at save — but
                  // an option that can only ever produce an error is one nobody
                  // should be able to pick in the first place.
                  options={(flows.data ?? [])
                    .filter((f) => f.id !== id)
                    .map((f) => ({ value: f.id, label: f.name }))}
                   onChange={(flowId) => patchNode(selectedNode.flowNode.id, { config: withConfig(selectedNode.flowNode.config, "flowId", flowId) })}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  它的出入参会长成这个节点的端口。指回本流程、或绕一圈回来，保存时会被拒。
                </Typography.Text>
              </div>
            )}

            {selectedNode.flowNode.type === "script" && (
              <>
                <ScriptBody
                  // Keyed by node, so a half-typed body belongs to the node on
                  // screen — two script nodes would otherwise share one draft.
                  // The two contract components used to live here too — they
                  // moved to the `io` tab so script's contract editing lands in
                  // the same place as every other node's (flowInput → 入参契约,
                  // flowOutput → 产出契约, etc.). Props is now strictly the
                  // node's metadata.
                  key={selectedNode.flowNode.id}
                  config={selectedNode.flowNode.config}
                  ports={selectedNode.ports}
                  onChange={(patch) => patchNode(selectedNode.flowNode.id, { config: patch })}
                />
              </>
            )}

            </>}

            {inspectorTab === "io" && <>
            {selectedNode.flowNode.type === "flowInput" && (
              <FlowInputContract
                config={selectedNode.flowNode.config}
                schemas={schemas.data ?? []}
                onChange={(config) => patchNodeConfig(selectedNode.flowNode, config)}
              />
            )}

            {selectedNode.flowNode.type === "book" && (
              <InheritedContract ports={selectedNode.ports} emptyHint="先在“属性”里绑定一本 Book" />
            )}

            {/* The subflow's contract used to render NOTHING: this tab had no
                `flow` branch at all, so selecting a subflow and asking what it
                takes showed an empty panel — on the one node type whose ports
                are entirely someone else's declaration and therefore the least
                guessable. `subflowPorts` had computed them all along. */}
            {selectedNode.flowNode.type === "flow" && (
              <InheritedContract ports={selectedNode.ports} emptyHint="先在“属性”里选一条子流程" />
            )}

            {/* The script node's contract halves live here — same tab as every
                other node's contract editor — so users don't relearn where
                "port shape" lives based on node type. The registry-cite /
                inline-define toggle and the `config.inputSchema ??
                schemaFor(config.inputSchemaRef)` resolution are unchanged
                from when these components used to sit under `props`.
                Switching modes clears the other key so the two cannot sit
                alongside each other in the saved JSON. */}
            {selectedNode.flowNode.type === "script" && (
              <>
                <ScriptInputContract
                  config={selectedNode.flowNode.config}
                  schemas={schemas.data ?? []}
                  onChange={(next) => patchNode(selectedNode.flowNode.id, { config: next })}
                />
                <ScriptOutputContract
                  config={selectedNode.flowNode.config}
                  schemas={schemas.data ?? []}
                  onChange={(next) => patchNode(selectedNode.flowNode.id, { config: next })}
                />
              </>
            )}

            {(selectedNode.flowNode.type === "map" || selectedNode.flowNode.type === "collect") && (
              // Neither has anything to configure — the array comes in on a
              // wire and the body is the graph. An empty inspector reads as
              // "broken", so say what the node does instead of showing nothing.
              <Space direction="vertical" size={10} style={{ width: "100%" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {selectedNode.flowNode.type === "map"
                    ? "接一个数组，下游到「收集结果」之间的节点会对每一项各跑一遍。逐项串行 —— 同时只允许一个会做事的节点，所以 20 项就是 20 轮。"
                    : "「逐项处理」每一项的结果送到这里，全部跑完后合成一个数组交给下游。"}
                </Typography.Text>
                {/* There IS a contract here — `propagateRouterSchemas` rebuilds
                    both ports off the incoming array, so a map接的是「商品[]」
                    时循环体拿到的就是「商品」。Saying only "nothing to
                    configure" hid the one thing worth reading. */}
                <InheritedContract ports={selectedNode.ports} emptyHint="接上一条线之后，这里会显示逐项的契约" />
              </Space>
            )}

            {selectedNode.flowNode.type === "branch" && (
              <BranchCasesEditor
                config={selectedNode.flowNode.config as BranchNodeConfig}
                onChange={(config) => patchNodeConfig(selectedNode.flowNode, config as FlowNode["config"])}
              />
            )}

            {selectedNode.flowNode.type === "merge" && (
              <MergeInputsEditor
                config={selectedNode.flowNode.config as MergeNodeConfig}
                onChange={(config) => patchNodeConfig(selectedNode.flowNode, config as FlowNode["config"])}
              />
            )}

            {selectedNode.flowNode.type === "transform" && (
              <TransformOutputEditor
                outputs={(selectedNode.flowNode.config as { outputs?: TransformOutput[] }).outputs ?? []}
                schemas={schemas.data ?? []}
                inputSchema={selectedNode.ports.find((p) => p.direction === "in")?.schema ?? null}
                onChange={(outputs) => patchNodeConfig(selectedNode.flowNode, { outputs } as FlowNode["config"])}
              />
            )}

            {selectedNode.flowNode.type === "flowOutput" && (
              <FlowOutputContract
                config={selectedNode.flowNode.config}
                schemas={schemas.data ?? []}
                onChange={(config) => patchNode(selectedNode.flowNode.id, { config })}
              />
            )}

            <Divider style={{ margin: "4px 0" }} plain>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                以上声明会长出下面这些端口
              </Typography.Text>
            </Divider>

            <div className='flow-interface'>
              <section className='flow-interface-section' aria-label='批量连接'>
                <h3>批量连接</h3>
                <div className='flow-batch-connect'>
                  <BcpSelect
                    style={{ width: '100%', minWidth: 0 }}
                    placeholder='选择目标节点'
                    value={batchTarget}
                    options={batchTargets}
                    onChange={setBatchTarget}
                    allowClear
                  />
                  <Button icon={<LinkOutlined />} disabled={!batchTarget} onClick={connectMatching}>
                    连接同名字段
                  </Button>
                </div>
                <p className='flow-interface-hint'>
                  按字段名和契约类型自动匹配；已有连线和不兼容字段会跳过
                </p>
              </section>
              {(['in', 'out'] as const).map(direction => {
                const group = selectedNode.ports.filter(p => p.direction === direction);
                const title = direction === 'in' ? '输入端口' : '输出端口';
                return <section className='flow-interface-section' aria-label={title} key={direction}>
                  <h3>{title}<span>{group.length}</span></h3>
                  {group.map(p => {
                    const connected = direction === 'in'
                      ? wiredInputs.has(`${selectedNode.flowNode.id}::${p.id}`)
                      : edges.some(edge => edge.source === selectedNode.flowNode.id && edge.sourceHandle === p.id);
                    return <div key={`${selectedNode.flowNode.id}-${direction}-${p.id}`} className='flow-port-field'>
                      <div className='flow-port-field-heading'>
                        <strong>{p.label}</strong>
                        {p.required && <span className='flow-port-required'>必填</span>}
                        <span className={`flow-port-connection${connected ? ' is-connected' : ''}`}>{connected ? '已连接' : '未连接'}</span>
                      </div>
                      <div className='flow-port-contract'><PortType schema={p.schema} /></div>
                      {direction === 'in' && !connected && (
                        <div className='flow-port-constant'>
                          <ConstantField
                            port={p}
                            value={constantsOf(selectedNode.flowNode.config)[p.id]}
                            onChange={(next) =>
                              patchNode(selectedNode.flowNode.id, { config: withConstant(selectedNode.flowNode.config, p.id, next) })
                            }
                          />
                        </div>
                      )}
                    </div>;
                  })}
                  {group.length === 0 && <p className='flow-interface-hint'>暂无{direction === 'in' ? '输入' : '输出'}端口</p>}
                </section>;
              })}
              {selectedNode.ports.some((p) => p.direction === "in") && (
                <p className='flow-interface-hint'>
                  未连线的入参可以直接填常量；接上线之后以线上的值为准
                </p>
              )}
            </div>
            </>}
          </Space>
        </aside>
      )}
      </div>

      {triggering && (
        <FlowTriggerDialog
          error={trigger.error?.message}
          specs={inputSpecs}
          schemaResolver={schemaLookup(schemas.data ?? [])}
          pending={trigger.isPending}
          onCancel={() => setTriggering(false)}
          onSubmit={(params) => {
            if (triggerInFlight.current) return;
            triggerInFlight.current = true;
            trigger.mutate(params);
          }}
        />
      )}
    </div>
  );
}

interface Snapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
}

function fieldSchemaRefProblems(graph: FlowGraph, schemas: SchemaRow[]): FlowProblem[] {
  const resolve = schemaLookup(schemas);
  const problems: FlowProblem[] = [];
  const checkRef = (node: FlowNode, path: string, ref: { name: string; version?: number } | undefined) => {
    if (!ref) return;
    const valid = typeof ref.name === "string" && ref.name.trim() !== "" && (ref.version === undefined || (Number.isInteger(ref.version) && ref.version > 0));
    if (!valid || !resolve(ref)) problems.push({ level: "error", at: node.id, path, tab: "io", message: `${node.label ?? node.id} / ${path}：Schema 引用 ${schemaCitationLabel(ref)} 不存在或版本无效` });
  };
  const checkSpecs = (node: FlowNode, path: string, specs: ParamSpec[]) => {
    for (const spec of specs) {
      if (!spec.schemaRef) continue;
      const ref = spec.schemaRef;
      const valid = typeof ref.name === "string" && ref.name.trim() !== "" && (ref.version === undefined || (Number.isInteger(ref.version) && ref.version > 0));
      if (!valid || !resolve(ref)) {
        problems.push({ level: "error", at: node.id, path: `${path}.${spec.name}`, tab: "io", message: `${node.label ?? node.id} / ${path} / ${spec.name}：Schema 引用 ${schemaCitationLabel(ref)} 不存在或版本无效` });
      }
    }
  };
  for (const node of graph.nodes) {
    const config = node.config as { params?: ParamSpec[]; schema?: ParamSchemaFragment | null; schemaRef?: { name: string; version?: number }; inputSchema?: ParamSchemaFragment | null; inputSchemaRef?: { name: string; version?: number }; outputSchema?: ParamSchemaFragment | null; outputSchemaRef?: { name: string; version?: number }; outputs?: Array<{ id: string; schema?: ParamSchemaFragment; schemaRef?: { name: string; version?: number } }> };
    if (node.type === "flowInput") {
      if ((config.params ?? []).length > 0) checkSpecs(node, "入参", config.params ?? []);
      else checkRef(node, "入参契约", config.schemaRef);
    }
    if (node.type === "flowOutput") checkRef(node, "产出契约", config.schemaRef);
    if (node.type === "flowOutput" && config.schema) checkSpecs(node, "产出", paramsOfSchema(config.schema));
    if (node.type === "script") {
      if (config.inputSchema) checkSpecs(node, "input", paramsOfSchema(config.inputSchema));
      else checkRef(node, "input 契约", config.inputSchemaRef);
      if (config.outputSchema) checkSpecs(node, "output", paramsOfSchema(config.outputSchema));
      else checkRef(node, "output 契约", config.outputSchemaRef);
    }
    if (node.type === "transform") {
      for (const output of config.outputs ?? []) {
        if (!output.schemaRef) continue;
        if (!resolve(output.schemaRef)) problems.push({ level: "error", at: node.id, path: `output.${output.id}`, tab: "io", message: `${node.label ?? node.id} / output ${output.id}：Schema 引用 ${schemaCitationLabel(output.schemaRef)} 不存在或版本无效` });
      }
    }
  }
  return problems;
}
