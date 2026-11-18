import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Descriptions, Card, Tag, Button, Typography, Steps, Spin, message, Space } from "antd";
import { CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { Activity, Boxes, Braces, CheckCheck, ChevronDown, Clock3, CircleCheck, CircleX, Send } from 'lucide-react';
import { LayoutGroup, m } from 'motion/react';
import { api } from "../lib/api";
import { TextClamp } from "../components/TextClamp";
import { PayloadView } from "../components/PayloadView";
import type { SchemaRecordRow } from "../lib/types";
import dayjs from "dayjs";
import { RunStatusTag } from "../components/RunStatusTag";
import { getRunStatusMeta, isRunActive, isRunRetryable, runArtifactSourcePrefix, runProductSource } from "../lib/types";
import { getPalette, useTheme } from '../theme';
import { formatDuration, formatBytes } from "../lib/format";
import { ContentView } from '../components/content-view';
import { StepResultView } from '../components/step-result-view';
import { RowActions } from "../components/RowActions";
import { PageTable } from "../components/PageTable";
import { DetailHeader } from '../components/detail-header';
import { ErrorState } from '../components/EmptyState';
import { MagicCard } from '../components/magicui/magic-card';
import { BorderBeam } from '../components/magicui/border-beam';
import './run-workspace.css';

export function RunDetail() {
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const { id } = useParams<{ id: string }>();
  const [workspaceSelection, setWorkspaceSelection] = useState<{ runId: string; section: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data;
       if (!d || isRunActive(d.status)) return 2000;
      return false;
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(id!),
    onSuccess: (result) => {
      if (result.ok) message.success('已取消');
      else message.info('运行已结束');
      qc.invalidateQueries({ queryKey: ["run", id] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const retry = useMutation({
    mutationFn: () => api.retryRun(id!),
    onSuccess: (r) => { window.location.hash = `#/runs/${r.run.id}`; },
    onError: (error: Error) => message.error(error.message),
  });
  // What the run PRODUCED no longer lives on the run row — it is SchemaRecord
  // rows keyed by source. One prefixed fetch brings back both the product
  // (`run:<id>`) and every file the run wrote (`run:<id>:artifact:<path>`),
  // because the artifact key is prefixed by the product key.
  const records = useQuery({
    queryKey: ["run-records", id],
    queryFn: () => api.listSchemaRecords({ sourcePrefix: runProductSource(id!) }),
    enabled: !!id,
  });

  const r = run.data;
  useEffect(() => {
    if (!r) return;
    setWorkspaceSelection(current => current?.runId === r.id ? current : { runId: r.id, section: r.steps.length ? 'execution' : 'inputs' });
  }, [r]);
  if (run.isError) return <ErrorState error={run.error} onRetry={() => run.refetch()} />;
  if (!r) return <Spin style={{ display: "block", marginTop: 80 }} />;

  const rows = records.data ?? [];
  const product = rows.find((row) => row.source === runProductSource(r.id));
  const artifacts = rows.filter((row) => row.source?.startsWith(runArtifactSourcePrefix(r.id)));

  const isActive = isRunActive(r.status);
  const waitingForAction = ['needsConfirm', 'needsJudge', 'noAction'].includes(r.status);
  const statusMeta = getRunStatusMeta(r.status);
  const endedSteps = r.steps.filter(step => ['success', 'failed', 'skipped', 'cancelled'].includes(step.status)).length;
  const firstUnfinishedStep = r.steps.findIndex(step => step.status !== 'success' && step.status !== 'skipped');
  const currentStep = firstUnfinishedStep === -1 ? r.steps.length : firstUnfinishedStep;
  const StatusIcon = r.status === 'success' ? CircleCheck : statusMeta.group === 'failed' ? CircleX : Activity;
  const selectedSection = workspaceSelection?.runId === r.id ? workspaceSelection.section : r.steps.length ? 'execution' : 'inputs';
  const selectSection = (section: string) => setWorkspaceSelection({ runId: r.id, section });
  const targetName = r.targetType === 'flow' ? (r as { flow?: { name?: string } | null }).flow?.name
    : r.targetType === 'script' ? (r as { script?: { name?: string } | null }).script?.name : r.book?.name;
  const sections = [
    { key: 'execution', label: '执行轨迹', Icon: Activity, count: r.steps.length },
    { key: 'inputs', label: '输入参数', Icon: Braces },
    { key: 'outputs', label: '运行产物', Icon: Boxes, count: records.isSuccess ? rows.length : undefined },
    { key: 'deliveries', label: '交付记录', Icon: Send, count: r.deliveries.length },
  ];

  return (
    <div className="console-detail-page run-detail-workspace">
      <DetailHeader title={`运行 ${r.id.slice(-8)}`} subtitle="执行详情 · 参数、步骤与产物" onBack={() => nav(-1)} actions={
        <Space>
          {(isActive || (r.status === 'cancelled' && r.planId)) && (
            <Button danger icon={<CloseCircleOutlined />} onClick={() => cancel.mutate()} loading={cancel.isPending}>
              {r.status === 'cancelled' ? '重试终止' : '取消'}
            </Button>
          )}
          {isRunRetryable(r.status) && r.targetType === 'book' && (
            <Button
              icon={<ReloadOutlined />}
              onClick={() => retry.mutate()}
              loading={retry.isPending}
              // 说清楚它到底做什么：沿用原参数【从第 1 步重新跑一遍】，不是从断点续跑。
              // 这条 book 会真的发布商品，操作者需要知道重跑意味着可能多出一个商品。
              title="沿用原参数重新排一次运行（从第 1 步开始，不是断点续跑）"
            >
              重试
            </Button>
          )}
        </Space>
      } />

      <MagicCard className="run-state-hero">
        <div className="run-state-main" data-status-group={statusMeta.group}>
          <div className="run-state-orbit" aria-hidden="true"><StatusIcon size={32} /></div>
          <div><span className="run-workspace-eyebrow">EXECUTION / {r.id.slice(-8)}</span><h2>{statusMeta.label}</h2><p>{isActive ? '状态每 2 秒更新，执行结果将陆续显示。' : waitingForAction ? '执行已暂停，等待确认、判断或进一步处理。' : '本次执行已结束，可查看步骤证据与运行产物。'}</p></div>
        </div>
        <div className="run-state-metrics">
          <div><Clock3 size={16} aria-hidden="true" /><span>执行耗时</span><strong>{formatDuration(r.durationMs)}</strong></div>
          <div><CheckCheck size={16} aria-hidden="true" /><span>已结束步骤</span><strong>{endedSteps}<small> / {r.steps.length}</small></strong></div>
          <div><Boxes size={16} aria-hidden="true" /><span>运行产物</span><strong>{records.isError || !records.data ? '—' : rows.length}</strong></div>
        </div>
        {isActive && <BorderBeam />}
      </MagicCard>

      <details className="run-context-rail">
      <summary><strong>执行上下文</strong><span className="run-context-summary"><span>{targetName ?? '未关联目标'}</span><span>{r.trigger} / {r.mode}</span><time>{dayjs(r.queuedAt).format('MM-DD HH:mm:ss')}</time></span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="run-context-expanded">
        <Descriptions column={{ xs: 1, sm: 2, lg: 3, xl: 4 }} size="small">
          <Descriptions.Item label="目标">
            {r.targetType === "flow" ? (
              <Link to={`/flows/${(r as { flow?: { id?: string } | null }).flow?.id ?? ""}`}>{(r as { flow?: { name?: string } | null }).flow?.name ?? "—"}</Link>
            ) : r.targetType === "script" ? (
              <Link to={`/scripts/${(r as { script?: { id?: string } | null }).script?.id ?? ""}`}>{(r as { script?: { name?: string } | null }).script?.name ?? "—"}</Link>
            ) : (
              r.book ? <Link to={`/books/${r.book.id}`}>{r.book.name}</Link> : <Typography.Text type="secondary">—</Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="状态">
             <RunStatusTag status={r.status} />
          </Descriptions.Item>
          <Descriptions.Item label="触发方式">{r.trigger}</Descriptions.Item>
          <Descriptions.Item label="模式">{r.mode}</Descriptions.Item>
          <Descriptions.Item label="计划 ID">
            {r.planId ? <code>{r.planId}</code> : <Typography.Text type="secondary">—</Typography.Text>}
          </Descriptions.Item>
          <Descriptions.Item label="耗时">
            {formatDuration(r.durationMs)}
          </Descriptions.Item>
          <Descriptions.Item label="入队时间">{dayjs(r.queuedAt).format("MM-DD HH:mm:ss")}</Descriptions.Item>
          <Descriptions.Item label="开始时间">
            {r.startedAt ? dayjs(r.startedAt).format("MM-DD HH:mm:ss") : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="结束时间">
            {r.finishedAt ? dayjs(r.finishedAt).format("MM-DD HH:mm:ss") : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="尝试次数">{r.attempt}</Descriptions.Item>
        </Descriptions>
      </div>
      </details>

      <main className="run-execution-body" aria-label="运行工作区">
      {r.errorMessage && <section className="run-failure-card" role="alert"><CircleX size={20} aria-hidden="true" /><div><h3>执行遇到问题</h3><TextClamp text={r.errorMessage} rows={3} /><details><summary>查看完整错误</summary><ContentView value={r.errorMessage} /></details></div></section>}
      {records.isError && <ErrorState error={records.error} onRetry={() => records.refetch()} />}

      <LayoutGroup id={`run-${r.id}`}>
        <div className="run-workspace-tabs" role="tablist" aria-label="运行工作区">
          {sections.map(({ key, label, Icon, count }, index) => <button key={key} type="button" role="tab" id={`run-tab-${key}`} aria-controls={`run-panel-${key}`} aria-selected={selectedSection === key} tabIndex={selectedSection === key ? 0 : -1}
            onClick={() => selectSection(key)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
              selectSection(sections[next].key);
              document.getElementById(`run-tab-${sections[next].key}`)?.focus();
            }}>
            {selectedSection === key && <m.span className="run-tab-highlight" layoutId="run-active-tab" transition={{ type: 'spring', stiffness: 420, damping: 35 }} aria-hidden="true" />}
            <Icon size={16} aria-hidden="true" /><span>{label}</span>{count !== undefined && <small>{count}</small>}
          </button>)}
        </div>
      </LayoutGroup>

      <section className="run-workspace-panel" id="run-panel-inputs" role="tabpanel" tabIndex={0} aria-labelledby="run-tab-inputs" hidden={selectedSection !== 'inputs'}>
        <header className="run-panel-heading"><div><span className="run-workspace-eyebrow">INPUT SNAPSHOT</span><h2>本次运行的输入</h2><p>运行时传入的实际参数，可展开结构查看，也可切换到原文。</p></div><Braces size={25} aria-hidden="true" /></header>
        <ContentView value={r.paramsJson} contentType="application/json" maxHeight={640} />
      </section>

      <section className="run-workspace-panel" id="run-panel-execution" role="tabpanel" tabIndex={0} aria-labelledby="run-tab-execution" hidden={selectedSection !== 'execution'}>
      <header className="run-panel-heading"><div><span className="run-workspace-eyebrow">EXECUTION TRACE</span><h2>执行轨迹</h2><p>{r.steps.length ? `${r.steps.length} 个步骤，已结束 ${endedSteps} 个。完整结果按需读取。` : '当前运行没有保存逐步执行记录。'}</p></div><Activity size={25} aria-hidden="true" /></header>

      {r.steps.length > 0 && (
        <div className="run-step-timeline">
          <Steps
            direction="vertical"
            size="small"
            current={currentStep}
            items={r.steps.map((s) => ({
              title: (
                <span>
                  {s.goal}
                  {s.status === "skipped" && (
                    <Tag color="default" style={{ marginLeft: 8 }}>跳过</Tag>
                  )}
                </span>
              ),
              description: (
                <div>
                  {s.actionMethod && <Tag>{s.actionMethod}</Tag>}
                  {s.durationMs != null && <Typography.Text type="secondary">{formatDuration(s.durationMs)}</Typography.Text>}
                  {s.errorMessage && <div style={{ color: palette.bad, fontSize: 12 }}>{s.errorMessage}</div>}
                  {s.valuePreview != null && <StepResultView key={s.id} step={s} />}
                </div>
              ),
              status: s.status === "success" ? "finish" : s.status === "failed" ? "error" : s.status === "running" ? "process" : "wait",
            }))}
          />
        </div>
      )}
      {r.steps.length === 0 && <div className="run-evidence-empty"><Activity size={22} aria-hidden="true" /><div><strong>暂无步骤记录</strong><p>{isActive ? '运行开始后，执行步骤将显示在这里。' : '可在“输入参数”中查看本次执行的输入，在“运行产物”中检查输出。'}</p></div></div>}
      </section>

      <section className="run-workspace-panel" id="run-panel-outputs" role="tabpanel" tabIndex={0} aria-labelledby="run-tab-outputs" hidden={selectedSection !== 'outputs'}>
      <header className="run-panel-heading"><div><span className="run-workspace-eyebrow">OUTPUT COLLECTION</span><h2>运行产物</h2><p>这次执行生成的结构化输出与文件，保留原始内容与下载入口。</p></div><Boxes size={25} aria-hidden="true" /></header>
      {records.isPending && <Spin tip="正在加载产物"><div style={{ minHeight: 100 }} /></Spin>}
      {artifacts.length > 0 && (
        <Card title="产物">
          <PageTable
            dataSource={artifacts}
            columns={[
              { title: "路径", key: "path", render: (_: unknown, rec: SchemaRecordRow) => artifactPathOf(rec, r.id) },
              { title: "类型", dataIndex: "contentType", key: "contentType", width: 160 },
              { title: "大小", dataIndex: "bytes", key: "bytes", width: 100, render: (b: number) => formatBytes(b) },
              {
                title: "", key: "download", width: 110, fixed: "right" as const,
                render: (_: unknown, rec: SchemaRecordRow) =>
                  rec.url ? (
                    <RowActions
                      actions={[{
                        key: "download",
                        label: "下载",
                        onClick: () => {
                          const a = document.createElement("a");
                          a.href = rec.url!;
                          a.download = "";
                          document.body.appendChild(a);
                          a.click();
                          a.remove();
                        },
                      }]}
                    />
                  ) : <Typography.Text type="secondary">—</Typography.Text>,
              },
            ]}
            rowKey="id"
            pagination={false}
            size="small"
            fill={false}
            // 下载列靠 fixed 留在右侧，而 fixed 需要一个横向滚动容器才生效。
            scroll={{ x: "max-content" }}
          />
        </Card>
      )}

      {product && (
        <Card title="Outputs" style={{ marginTop: 16 }}>
          <PayloadView record={product} />
        </Card>
      )}

      {records.isSuccess && rows.length === 0 && <div className="run-evidence-empty"><Boxes size={22} aria-hidden="true" /><div><strong>暂无运行产物</strong><p>{isActive ? '运行产物将在生成后显示。' : '这次运行没有生成结构化输出或文件。'}</p></div></div>}
      </section>

      <section className="run-workspace-panel" id="run-panel-deliveries" role="tabpanel" tabIndex={0} aria-labelledby="run-tab-deliveries" hidden={selectedSection !== 'deliveries'}>
      <header className="run-panel-heading"><div><span className="run-workspace-eyebrow">DELIVERY RECEIPTS</span><h2>交付记录</h2><p>产物投递的实际结果、尝试次数与接收方反馈。</p></div><Send size={25} aria-hidden="true" /></header>
      {r.deliveries.length > 0 && (
        <Card title="Delivery 结果" style={{ marginTop: 16 }}>
          <PageTable
            dataSource={r.deliveries}
            columns={[
              { title: "类型", dataIndex: "kind", key: "kind" },
              { title: "状态", dataIndex: "status", key: "status", render: (s: string) => <Tag color={s === "ok" ? "success" : s === "error" ? "error" : "default"}>{s}</Tag> },
              { title: "尝试", dataIndex: "attempts", key: "attempts" },
              { title: "结果", dataIndex: "detail", key: "detail", render: (v: string | null) => v || "—" },
            ]}
            rowKey="id"
            pagination={false}
            size="small"
            fill={false}
          />
        </Card>
      )}
      {r.deliveries.length === 0 && <div className="run-evidence-empty"><Send size={22} aria-hidden="true" /><div><strong>暂无交付记录</strong><p>这次运行没有保存产物投递记录。</p></div></div>}
      </section>
      </main>
    </div>
  );
}

/** The report-relative path an artifact row stands for. It is carried in the
 *  source key rather than a column of its own — `fileName` is the content-hashed
 *  name under resource/records/, which is not what the book asked to write. */
function artifactPathOf(record: SchemaRecordRow, runId: string): string {
  return record.source?.slice(runArtifactSourcePrefix(runId).length) ?? "";
}
