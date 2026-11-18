import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import {
  ArrowLeftOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  EditOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../lib/api";
import { FLOW_NODE_TYPE_LABELS, flowProductSource, parseFlowGraph } from "../lib/types";
import { ContractTag, PayloadView } from "../components/PayloadView";
import type { FlowNodeRunRow, FlowNodeType, FlowRunRow } from "../lib/types";
import { RunStatusTag } from "../components/RunStatusTag";
import { formatBytes, formatDuration } from "../lib/format";
import { PageTable } from "../components/PageTable";
import { PageShell } from '../components/PageShell';
import { ErrorState } from '../components/EmptyState';
import { ContentView } from '../components/content-view';
import { BranchConditions, FlowRunDiagnosisPanel, PhaseTimings, RunErrorNote } from '../components/flow-run-summary';
import { deriveFlowDiagnostics, diagnosticRun } from '../lib/flow-diagnostics';

const NODE_STATUS_COLOR: Record<string, string> = {
  pending: "default",
  ready: "blue",
  running: "processing",
  success: "success",
  failed: "error",
  skipped: "warning",
  cancelled: 'default',
};

const NODE_STATUS_LABEL: Record<string, string> = {
  pending: "待运行",
  ready: "就绪",
  running: "运行中",
  success: "成功",
  failed: "失败",
  skipped: "已跳过",
  cancelled: '已取消',
};

/** 状态 → Hero 横幅用的语义色 */
const STATUS_TONE: Record<string, { color: string; label: string }> = {
  success: { color: "var(--c-ok)", label: "成功" },
  failed: { color: "var(--c-bad)", label: "失败" },
  running: { color: "var(--c-info)", label: "运行中" },
  pending: { color: "var(--c-ink-3)", label: "排队中" },
  ready: { color: "var(--c-info)", label: "就绪" },
  cancelled: { color: "var(--c-ink-3)", label: "已取消" },
  skipped: { color: "var(--c-warn)", label: "已跳过" },
};

/** 节点状态 → 时间线圆点颜色 */
const NODE_DOT_COLOR: Record<string, string> = {
  success: "var(--c-ok)",
  failed: "var(--c-bad)",
  running: "var(--c-info)",
  skipped: "var(--c-warn)",
  pending: "var(--c-ink-3)",
  ready: "var(--c-info)",
  cancelled: "var(--c-ink-3)",
};

/** 只有还在推进的状态才配呼吸灯。终态（成功/失败/已取消/已跳过）给它一个
 *  静止的点 —— 一个永远在脉冲的「已取消」在说「它还在动」，那是假消息。 */
const LIVE_STATUSES = ["running", "ready", "pending"];

/** List of runs for a flow (or all flows), used from the editor's toolbar. */
export function FlowRuns() {
  const [search] = useSearchParams();
  const flowId = search.get("flowId") ?? undefined;
  const runs = useQuery({ queryKey: ["flow-runs", flowId], queryFn: () => api.listFlowRuns(flowId), refetchInterval: 3000 });

  const columns = [
    {
      title: "运行",
      dataIndex: "id",
      render: (id: string, run: FlowRunRow) => (
        <Link to={`/flow-runs/${id}`}>
          <Typography.Text code>{id.slice(0, 8)}</Typography.Text> {run.flow?.name}
        </Link>
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (s: string) => <RunStatusTag status={s} /> },
    { title: "触发", dataIndex: "trigger", width: 90 },
    { title: "开始", dataIndex: "queuedAt", width: 160, render: (t: string) => dayjs(t).format("YYYY-MM-DD HH:mm:ss") },
    { title: "耗时", dataIndex: "durationMs", width: 90, render: (ms: number | null) => formatDuration(ms) },
  ];

  return (
    <PageShell title="流程运行" subtitle="查看流程执行状态、耗时与诊断详情">
      <PageTable rowKey="id" size="middle" query={runs} dataSource={runs.data ?? []} columns={columns} pagination={false}
        empty={{ title: '还没有运行记录', description: '执行流程后，可以在这里查看运行进度和诊断结果。' }} />
    </PageShell>
  );
}

/** 选出默认聚焦节点：运行中 → 失败 → failedNodeId → null */
function pickDefaultNode(nodes: FlowNodeRunRow[], failedNodeId: string | null): FlowNodeRunRow | null {
  const running = nodes.find((n) => n.status === "running");
  if (running) return running;
  const failed = nodes.find((n) => n.status === "failed");
  if (failed) return failed;
  if (failedNodeId) {
    const byId = nodes.find((n) => n.nodeId === failedNodeId);
    if (byId) return byId;
  }
  return null;
}

export function FlowRunDetail() {
  const { id = "" } = useParams();
  const [viewingNode, setViewingNode] = useState<FlowNodeRunRow | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: ["flow-run", id],
    queryFn: () => api.getFlowRun(id),
    refetchInterval: (q) => (["success", "failed", "cancelled"].includes(q.state.data?.status ?? "") ? false : 1500),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelFlowRun(id),
    onSuccess: () => {
      message.success("已取消");
      qc.invalidateQueries({ queryKey: ["flow-run", id] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const records = useQuery({
    queryKey: ["flow-run-records", id],
    queryFn: () => api.listSchemaRecords({ sourcePrefix: flowProductSource(id) }),
    enabled: !!id,
  });
  const product = (records.data ?? []).find((row) => row.source === flowProductSource(id));

  // 所有 hooks 必须在 early return 之前
  const safeRun = run.data ? diagnosticRun(run.data) : null;
  const model = useMemo(() => (safeRun ? deriveFlowDiagnostics(safeRun) : null), [safeRun]);
  const nodes = safeRun?.nodes ?? [];

  const timingByRowId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof model>['timings'][number]>();
    model?.timings.forEach((t) => map.set(t.key, t));
    return map;
  }, [model]);
  const branchByRowId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof model>['branches'][number]>();
    model?.branches.forEach((b) => map.set(b.key, b));
    return map;
  }, [model]);

  // 默认选中节点（仅首次数据到达时设定）。必须在 early return 之前算出来 ——
  // 下面那个「把选中项滚进可视区」的 effect 要用它，而 hook 不能排在 return 之后。
  const effectiveSelectedId = selectedNodeId ?? (safeRun ? pickDefaultNode(nodes, safeRun.failedNodeId)?.id ?? null : null);

  const listRef = useRef<HTMLDivElement>(null);
  /**
   * 时间线现在是内部滚动的：12 个节点时，默认选中的那个失败节点很可能不在可视
   * 区里 —— 右侧明明在讲它的详情，左边的列表却看不出选中了谁。
   *
   * `block: 'nearest'` 是关键：已经在视野内就一动不动，用户自己滚到别处也不会
   * 被拽回来。只有"选中项在视口外"这一种情况会触发滚动。
   */
  useEffect(() => {
    if (!effectiveSelectedId) return;
    const target = listRef.current?.querySelector(`[data-row-id="${CSS.escape(effectiveSelectedId)}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  }, [effectiveSelectedId]);

  if (!safeRun || !model) return <Typography.Text type="secondary">加载中…</Typography.Text>;
  const graph = parseFlowGraph(safeRun.graphSnapshot);
  const labelOf = (nodeId: string) => graph.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const tone = STATUS_TONE[safeRun.status] ?? STATUS_TONE.pending;

  const selectedNode = nodes.find((n) => n.id === effectiveSelectedId) ?? null;

  const showCancel =
    !['success', 'failed', 'cancelled'].includes(safeRun.status) ||
    (safeRun.status === 'cancelled' && nodes.some((node) => ['running', 'pending', 'ready'].includes(node.status)));

  return (
    <div className="frd-page">
      {/* ── Hero 状态横幅 ──────────────────────────────────────── */}
      {/* 这里原本还有一层 radial-gradient 的「光晕」，但它是个固定尺寸的椭圆，
          压在 87px 高的横幅上会露出可见的边缘 —— 读起来像渲染坏了，而不是装饰。
          顶栏里唯一该有颜色的东西是状态徽章。 */}
      <header className="frd-hero" style={{ ['--tone' as string]: tone.color }}>
        <div className="frd-hero-row frd-hero-top">
          <Link to={`/flows/${safeRun.flowId}`} className="frd-back">
            <ArrowLeftOutlined /> {safeRun.flow?.name ?? "流程"}
          </Link>
          <Space size={8}>
            {safeRun.failedNodeId && (
              <Link to={`/flows/${safeRun.flowId}?node=${encodeURIComponent(safeRun.failedNodeId)}&tab=io`}>
                <Button size="small" icon={<EditOutlined />}>编辑失败节点</Button>
              </Link>
            )}
            {showCancel && (
              <Button size="small" danger loading={cancel.isPending} onClick={() => cancel.mutate()}>
                {safeRun.status === 'cancelled' ? '重试终止节点' : '取消运行'}
              </Button>
            )}
          </Space>
        </div>

        <div className="frd-hero-row frd-hero-main">
          <div className="frd-hero-title-block">
            <h1 className="frd-hero-title">{safeRun.flow?.name ?? "流程运行"}</h1>
            <Typography.Text className="frd-hero-id" code>{id}</Typography.Text>
          </div>
          <div className="frd-hero-stats-inline">
            <span className="frd-stat-inline">
              <PlayCircleOutlined /> <b>{safeRun.trigger}</b>
            </span>
            <span className="frd-stat-sep" />
            <span className="frd-stat-inline">
              <CalendarOutlined /> <b>{dayjs(safeRun.queuedAt).format("MM-DD HH:mm:ss")}</b>
            </span>
            <span className="frd-stat-sep" />
            <span className="frd-stat-inline">
              <ClockCircleOutlined /> <b>{formatDuration(safeRun.durationMs)}</b>
            </span>
          </div>
          <div className="frd-hero-status">
            <span className={`frd-status-pulse${LIVE_STATUSES.includes(safeRun.status) ? ' is-live' : ''}`} />
            <span className="frd-status-text">{tone.label}</span>
          </div>
        </div>
      </header>

      {/* ── 流程产出 ───────────────────────────────────────────────
          它从页面最底部搬到了这里。理由很实在：实测 3 种状态 × 3 种视口共 6 次，
          它**每一次都在首屏之外**（top 1057~1513）—— 而这是这条运行的结果。放在
          时间线之前，读序就是「跑成了吗 → 产出了什么 → 怎么跑出来的」。
          失败/取消的运行往往没有产出，这一块自然消失，不会留下空洞。 */}
      {records.isError && <section className="frd-output" aria-label="流程产出"><ErrorState error={records.error} onRetry={() => records.refetch()} /></section>}
      {records.isPending && <section className="frd-output" aria-label="流程产出"><Spin tip="正在加载产出"><div style={{ minHeight: 100 }} /></Spin></section>}
      {product && (
        <section className="frd-output" aria-label="流程产出">
          <div className="frd-output-head">
            <div className="frd-output-title">
              <FileTextOutlined style={{ color: 'var(--c-accent)' }} />
              <span>流程产出</span>
              <span className="frd-output-sub">运行落盘的产出快照</span>
            </div>
            <div className="frd-output-meta">
              {/* 契约判定放在头部：它是对这份产出的「结论」，比工件的物理属性更该先被看到。 */}
              <ContractTag errors={product.schemaErrors} />
              {product.schemaName && <span className="frd-output-badge frd-output-badge--schema">{product.schemaName}@{product.schemaVersion}</span>}
              <span className="frd-output-badge">{formatBytes(product.bytes)}</span>
            </div>
          </div>
          <div className="frd-output-body">
            <PayloadView record={product} chrome="artifact" />
          </div>
        </section>
      )}

      {/* ── 主网格：时间线 + 检视面板 ───────────────────────────── */}
      {/* 运行级错误不在这里另起一条横幅：失败节点的卡片、右侧诊断面板都在讲同一句
          话，重复三遍只会把真正的结论挤下去。它现在折叠在诊断面板里（RunErrorNote）。 */}
      <div className="frd-main-grid">
        {/* 左：执行时间线 */}
        <div className="frd-timeline">
          <div className="frd-timeline-head">
            <span className="frd-timeline-title">执行时间线</span>
            <span className="frd-timeline-count">{nodes.length} 个节点</span>
          </div>
          <div className="frd-tl-scroll" ref={listRef}>
            <div className="frd-tl-list">
              {nodes.map((node) => {
                const dotColor = NODE_DOT_COLOR[node.status] ?? 'var(--c-ink-3)';
                const isActive = node.status === 'running' || node.status === 'failed';
                const isDone = node.status === 'success';
                const isFailed = node.status === 'failed';
                const isRunning = node.status === 'running';
                const isSkipped = node.status === 'skipped';
                const isSelected = node.id === effectiveSelectedId;
                const timing = timingByRowId.get(node.id);
                const branch = branchByRowId.get(node.id);
                const hasExtra = !!timing || !!branch;

                return (
                  <div
                    key={node.id}
                    data-row-id={node.id}
                    className={`frd-tl-item ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''} ${isFailed ? 'is-failed' : ''} ${isRunning ? 'is-running' : ''} ${isSkipped ? 'is-skipped' : ''} ${isSelected ? 'is-selected' : ''}`}
                  >
                    <div className="frd-tl-rail">
                      <span className="frd-tl-dot" style={{ ['--dot-color' as string]: dotColor, borderColor: dotColor }} />
                    </div>
                    <div className="frd-tl-card" onClick={() => setSelectedNodeId(node.id)}>
                      <div className="frd-tl-card-head">
                        <div className="frd-tl-card-title">
                          <span className="frd-tl-name">{labelOf(node.nodeId)}</span>
                          <Tag bordered={false} className="node-type-tag">
                            {FLOW_NODE_TYPE_LABELS[node.nodeType as FlowNodeType] ?? node.nodeType}
                          </Tag>
                        </div>
                        <div className="frd-tl-card-meta">
                          <Tag color={NODE_STATUS_COLOR[node.status] ?? 'default'} bordered={false}>
                            {NODE_STATUS_LABEL[node.status] ?? node.status}
                          </Tag>
                          {node.durationMs != null && (
                            <span className="frd-tl-duration">{formatDuration(node.durationMs)}</span>
                          )}
                        </div>
                      </div>

                      {node.errorMessage && (
                        <div className={`frd-tl-card-note ${isFailed ? 'is-error' : ''}`}>{node.errorMessage}</div>
                      )}

                      {(node.inputJson || node.outputJson || node.runId) && (
                        <div className="frd-tl-card-actions">
                          {node.runId && (
                            <Tooltip title="每个 book 节点都是一条真实的 Run，步骤历史与投递都在那里">
                              <Link to={`/runs/${node.runId}`} onClick={(e) => e.stopPropagation()}>
                                <Button size="small" type="link" style={{ padding: 0 }}>查看 Run →</Button>
                              </Link>
                            </Tooltip>
                          )}
                          {(node.inputJson || node.outputJson) && (
                            <Button size="small" type="link" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); setViewingNode(node); }}>
                              查看数据
                            </Button>
                          )}
                          {hasExtra && <span style={{ fontSize: 11, color: 'var(--c-ink-3)', marginLeft: 'auto' }}>含明细</span>}
                        </div>
                      )}

                      {hasExtra && (
                        <div className="frd-tl-extra" onClick={(e) => e.stopPropagation()}>
                          {timing && <PhaseTimings timing={timing} />}
                          {branch && <BranchConditions branch={branch} />}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 右：详情面板 */}
        <aside className="frd-detail">
          <div className="frd-detail-head">
            <span className="frd-detail-title">
              {selectedNode ? (
                <>
                  <span className="frd-tl-name" style={{ fontSize: 13 }}>{labelOf(selectedNode.nodeId)}</span>
                  <Tag bordered={false} className="node-type-tag">
                    {FLOW_NODE_TYPE_LABELS[selectedNode.nodeType as FlowNodeType] ?? selectedNode.nodeType}
                  </Tag>
                </>
              ) : (
                '业务诊断'
              )}
            </span>
            {selectedNode && (
              <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setSelectedNodeId(null)} />
            )}
          </div>
          <div className="frd-detail-body">
            {/* 运行级错误挂在面板层而不是「业务诊断」视图里：失败的运行默认会把
                面板切到出错节点，错误就跟着一起消失了 —— 那正是它最该在的时候。
                放在这里，节点详情和业务诊断两个视图都盖得住。
                但节点自己那条错误原样就是运行级错误（线上 30 条失败运行逐条比对，
                30/30 完全相同），所以选中节点已经在报错时不再重复第二遍。 */}
            {safeRun.errorMessage && !selectedNode?.errorMessage && (
              <RunErrorNote message={safeRun.errorMessage} nodeLabel={model.failedNodeLabel} />
            )}
            {selectedNode ? (
              <NodeDetail
                node={selectedNode}
                label={labelOf(selectedNode.nodeId)}
                timing={timingByRowId.get(selectedNode.id)}
                branch={branchByRowId.get(selectedNode.id)}
                onViewData={() => setViewingNode(selectedNode)}
              />
            ) : (
              <FlowRunDiagnosisPanel model={model} />
            )}
          </div>
        </aside>
      </div>

      <Drawer
        width={620}
        open={!!viewingNode}
        onClose={() => setViewingNode(null)}
        title={viewingNode ? `${labelOf(viewingNode.nodeId)} · 节点数据（已脱敏）` : '节点数据（已脱敏）'}
      >
        {viewingNode && (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Tag color={NODE_STATUS_COLOR[viewingNode.status] ?? "default"}>{NODE_STATUS_LABEL[viewingNode.status] ?? viewingNode.status}</Tag>
            {viewingNode.inputJson && <div><Typography.Text strong>实际输入</Typography.Text><ContentView value={viewingNode.inputJson} contentType="application/json" /></div>}
            {viewingNode.outputJson && <div><Typography.Text strong>实际输出</Typography.Text><ContentView value={viewingNode.outputJson} contentType="application/json" /></div>}
            <Typography.Text type="secondary">运行使用的是该次 FlowRun 的 graph snapshot；修改当前流程不会改变这里的数据。</Typography.Text>
          </Space>
        )}
      </Drawer>
    </div>
  );
}

/** 节点详情（右侧面板） */
function NodeDetail({
  node, label, timing, branch, onViewData,
}: {
  node: FlowNodeRunRow;
  label: string;
  timing?: ReturnType<typeof deriveFlowDiagnostics>['timings'][number];
  branch?: ReturnType<typeof deriveFlowDiagnostics>['branches'][number];
  onViewData: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <dl className="frd-detail-meta-grid">
        <dt>状态</dt>
        <dd><Tag color={NODE_STATUS_COLOR[node.status] ?? 'default'} bordered={false}>{NODE_STATUS_LABEL[node.status] ?? node.status}</Tag></dd>
        <dt>类型</dt>
        <dd>{FLOW_NODE_TYPE_LABELS[node.nodeType as FlowNodeType] ?? node.nodeType}</dd>
        {node.durationMs != null && <><dt>耗时</dt><dd>{formatDuration(node.durationMs)}</dd></>}
        {node.startedAt && <><dt>开始</dt><dd>{dayjs(node.startedAt).format('MM-DD HH:mm:ss')}</dd></>}
        {node.finishedAt && <><dt>结束</dt><dd>{dayjs(node.finishedAt).format('MM-DD HH:mm:ss')}</dd></>}
      </dl>

      {node.errorMessage && (
        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'color-mix(in srgb, var(--c-bad) 8%, transparent)', borderLeft: '2px solid var(--c-bad)', fontSize: 12, color: 'var(--c-bad)' }}>
          {node.errorMessage}
        </div>
      )}

      {(node.inputJson || node.outputJson) && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <h4 className="frd-detail-section-title">输入 / 输出</h4>
            <Button size="small" type="link" style={{ padding: 0 }} onClick={onViewData}>完整数据 →</Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {node.inputJson && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>输入</Typography.Text>
                <ContentView value={node.inputJson} contentType="application/json" />
              </div>
            )}
            {node.outputJson && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>输出</Typography.Text>
                <ContentView value={node.outputJson} contentType="application/json" />
              </div>
            )}
          </div>
        </div>
      )}

      {timing && (
        <div>
          <h4 className="frd-detail-section-title">阶段耗时</h4>
          <PhaseTimings timing={timing} />
        </div>
      )}

      {branch && (
        <div>
          <h4 className="frd-detail-section-title">分支判断</h4>
          <BranchConditions branch={branch} />
        </div>
      )}
    </div>
  );
}
