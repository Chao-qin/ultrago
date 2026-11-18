import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { FlowRunRow } from '../lib/types';
import { deriveFlowDiagnostics, exportFlowDiagnostics } from '../lib/flow-diagnostics';
import { FLOW_STATUS_LABELS } from '../lib/flow-execution';
import { ContentView } from './content-view';

const PHASE_LABELS: Record<string, string> = {
  data_preparation: '数据准备', category_attribute_mapping: '类目与属性映射', llm_image_work: '模型与图片处理', projection_validation: '投影与校验', result_assembly: '结果组装',
};
const PHASE_STATUS_TONE: Record<string, string> = {
  completed: 'var(--c-ok)', success: 'var(--c-ok)', failed: 'var(--c-bad)', skipped: 'var(--c-warn)',
};

/** 业务结果 level → 色调 */
const BUSINESS_TONE: Record<string, { color: string; icon: typeof InfoCircleOutlined }> = {
  success: { color: 'var(--c-ok)', icon: CheckCircleOutlined },
  info: { color: 'var(--c-info)', icon: InfoCircleOutlined },
  warning: { color: 'var(--c-warn)', icon: WarningOutlined },
  error: { color: 'var(--c-bad)', icon: CloseCircleOutlined },
};

type DiagnosticsModel = ReturnType<typeof deriveFlowDiagnostics>;
type BranchDiagnostic = DiagnosticsModel['branches'][number];
type PhaseTiming = DiagnosticsModel['timings'][number];

function DiagnosticOperand({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const complex = value !== null && typeof value === 'object';
  const longText = typeof value === 'string' && value.length > 160;
  if (!complex && !longText) return <code>{JSON.stringify(value) ?? '字段缺失'}</code>;
  const preview = complex
    ? Array.isArray(value) ? `数组 · ${value.length} 项` : `对象 · ${Object.keys(value).length} 个字段`
    : `${JSON.stringify((value as string).slice(0, 160))}…`;
  return <details className='frd-operand' onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><code>{preview}</code> · 查看完整值（已脱敏）</summary>
    {expanded && <ContentView value={value} />}
  </details>;
}

/** 单个分支节点的条件判断（时间线内嵌 / 详情面板通用）。
 *
 *  `label` 只在调用方没有别的途径交代「这是哪个节点」时才传：时间线里卡片标题
 *  已经写着节点名，再印一遍就是重复；而编辑器的执行监控侧栏是一串平铺的条件，
 *  少了它会分不清每条属于谁。 */
export function BranchConditions({ branch, label }: { branch: BranchDiagnostic; label?: string }) {
  const hasCases = branch.cases.length > 0;
  return (
    <div className='frd-branch'>
      {label && <p className='frd-branch-label'>{label}</p>}
      {branch.selectedPort !== null && <p className='frd-branch-port'>已记录端口：{branch.selectedPort || '未选择任何分支'}</p>}
      {branch.notice && <p className='frd-muted'>{branch.notice}</p>}
      {branch.cases.map((item) => {
        const matched = item.matched;
        const tone = matched === null ? 'var(--c-ink-3)' : matched ? 'var(--c-ok)' : 'var(--c-bad)';
        return (
          <div className='frd-condition' key={item.id} style={{ ['--cond-tone' as string]: tone, borderLeftColor: tone }}>
            <div className='frd-condition-path'>
              <code>{String(item.path)}</code>
              <span className='frd-condition-op'>{item.op}</span>
            </div>
            <div className='frd-condition-value'>
              {item.presence === 'redacted' ? '已脱敏，无法比较' : item.presence === 'missing' ? '字段缺失' : <DiagnosticOperand value={item.value} />}
            </div>
            {item.right !== undefined && item.presence !== 'redacted' && (
              <div className='frd-condition-right'>比较值：<DiagnosticOperand value={item.right} /></div>
            )}
            <Tag color={matched === null ? 'default' : matched ? 'success' : 'error'} bordered={false} className='frd-condition-tag'>
              {matched === null ? '判断不可用' : matched ? '条件成立' : '条件不成立'}
            </Tag>
          </div>
        );
      })}
      {!hasCases && branch.state !== 'not_run' && <p className='frd-muted'>该分支已执行但未记录条件明细。</p>}
    </div>
  );
}

/**
 * 单个节点的阶段耗时（时间线内嵌 / 详情面板通用）。
 *
 * 两个口径必须同源，否则这一块会自己咬自己：条长原本按「最慢阶段」归一，
 * 而旁边的百分比按「总耗时」归一，于是 90% 长的条会顶着 "47%" —— 长度和
 * 数字讲两个故事。这里统一到 totalMs（生产方 `phase_timings.py` 的 snapshot
 * 用的就是外层墙钟时长），条长与百分比都回答同一个问题：「这一步花了本次
 * 耗时的百分之多少」。
 *
 * 阶段之间可以重叠（`start_stage`/`finish_stage` 成对出现，同名阶段还会累加，
 * 见 `test_phase_timings.py::test_total_uses_outer_elapsed_instead_of_summing_overlapping_stages`），
 * 所以各阶段占比之和可以大于 100%。这是事实而不是 bug，如实标出来比假装
 * 它们是串行更有用 —— 调试「为什么跑了 8 分钟」时，知道有两步在并行是关键。
 *
 * 颜色只表达「耗时权重」（最慢那条用强调色，其余用中性色），状态交给行首圆点
 * 和行左侧的失败描边 —— 早先按状态给整条染色，会让一条 250 秒的成功阶段和
 * 一条 250 秒的失败阶段长得几乎一样，红色反而盖掉了真正要看的东西。
 */
export function PhaseTimings({ timing }: { timing: PhaseTiming }) {
  const total = timing.totalMs > 0 ? timing.totalMs : 1;
  const stageSum = timing.stages.reduce((acc, stage) => acc + stage.durationMs, 0);
  const maxIdx = timing.stages.reduce((best, stage, index, all) => (stage.durationMs > all[best].durationMs ? index : best), 0);
  const slowest = timing.stages[maxIdx];
  const failedCount = timing.stages.filter((stage) => stage.status === 'failed').length;
  // 1.02 的余量：阶段边界取整后会有几毫秒的合法溢出，不该被渲染成"有重叠"。
  const overlapping = timing.stages.length > 1 && stageSum > total * 1.02;
  const share = (durationMs: number) => Math.min(100, (durationMs / total) * 100);

  return (
    <div className='frd-timing-group'>
      <div className='frd-timing-head'>
        <span>{timing.label}</span>
        <span className='frd-timing-total'>{timing.totalMs} ms</span>
      </div>

      <div className='frd-timing-overview'>
        {slowest && timing.stages.length > 1 && (
          <span className='frd-timing-ov-slowest'>
            最慢 {PHASE_LABELS[slowest.name] ?? slowest.name} · {Math.round(share(slowest.durationMs))}%
          </span>
        )}
        {failedCount > 0 && <span className='frd-timing-ov-bad'>{failedCount} 个阶段失败</span>}
        {overlapping && (
          <Tooltip title='同名阶段会累加，且阶段可以重叠，因此各阶段占比之和可能大于 100%。总耗时是外层墙钟时间。'>
            <span className='frd-timing-ov-hint'>阶段存在重叠 · 占比之和 {Math.round((stageSum / total) * 100)}%</span>
          </Tooltip>
        )}
      </div>

      <div className='frd-timing-bars'>
        {timing.stages.map((stage, index) => {
          const pct = share(stage.durationMs);
          const isSlowest = index === maxIdx && timing.stages.length > 1;
          const isFailed = stage.status === 'failed';
          const tone = PHASE_STATUS_TONE[stage.status] ?? 'var(--c-ink-3)';
          const weight = isSlowest ? 'var(--c-accent)' : 'var(--c-ink-3)';
          return (
            <div className={`frd-timing-row${isSlowest ? ' is-slowest' : ''}${isFailed ? ' is-failed' : ''}`} key={`${stage.name}-${index}`}>
              <div className='frd-timing-name'>
                <Tooltip title={stage.status}><span className='frd-timing-dot' style={{ background: tone }} /></Tooltip>
                <span className='frd-timing-label'>{PHASE_LABELS[stage.name] ?? stage.name}</span>
                {isFailed && <span className='frd-timing-failed-tag'>失败</span>}
              </div>
              <div className='frd-timing-bar'>
                <div
                  className='frd-timing-fill'
                  style={{
                    width: `${Math.max(1.5, pct)}%`,
                    background: `linear-gradient(90deg, color-mix(in srgb, ${weight} 45%, transparent), ${weight})`,
                  }}
                />
              </div>
              <div className='frd-timing-ms'>
                <span className='frd-timing-pct'>{pct < 1 ? '<1' : Math.round(pct)}%</span>
                <span className='frd-timing-ms-val'>{stage.durationMs} ms</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 运行级错误，折叠进诊断卡片。
 *
 * 这原本是一条横跨整页的独立横幅，但它跟「失败节点卡片」和「右侧面板」讲的是
 * 同一句话 —— 一次失败的运行里，同一段错误文本会在屏幕上出现三遍，而真正
 * 需要被看见的（哪个节点挂了、业务结果是什么）反而被挤到下面。现在它作为
 * 面板里的一块出现，带上是哪个节点，信息不丢而重复没了。
 */
export function RunErrorNote({ message, nodeLabel }: { message: string; nodeLabel?: string | null }) {
  return (
    <div className='frd-diag-error'>
      <div className='frd-diag-error-head'>
        <CloseCircleOutlined />
        <span>技术错误</span>
        {nodeLabel && <code>{nodeLabel}</code>}
      </div>
      <p className='frd-diag-error-body'>{message}</p>
    </div>
  );
}

/** 业务诊断面板（详情面板默认视图）。
 *
 *  运行级错误不在这里渲染 —— 它挂在面板外层（见 FlowRunDetail 的 aside），
 *  否则失败的运行一旦把面板切到出错节点，错误就跟着消失了。 */
export function FlowRunDiagnosisPanel({ model }: { model: DiagnosticsModel }) {
  const { business, businessRunId, run, resumeNotice, snapshotAvailable } = model;
  const businessTone = business ? (BUSINESS_TONE[business.level ?? 'info'] ?? BUSINESS_TONE.info) : null;
  const BusinessIcon = businessTone?.icon ?? InfoCircleOutlined;

  return (
    <div className='frd-diag-panel' role='region' aria-label='运行结果与诊断'>
      {/* 业务结论横幅：整合标签 + 原因 */}
      <div className='frd-diag-banner' style={{ ['--tone' as string]: businessTone?.color ?? 'var(--c-ink-3)' }}>
        <BusinessIcon className='frd-diag-banner-icon' style={{ color: businessTone?.color }} />
        <div className='frd-diag-banner-main'>
          <div className='frd-diag-banner-row'>
            <span className='frd-diag-banner-label'>业务结果</span>
            <span className='frd-diag-banner-value'>
              {business ? business.label ?? business.status : '业务结果尚未确定'}
            </span>
          </div>
          {business?.reason && <p className='frd-diag-banner-reason'>{business.reason}</p>}
        </div>
      </div>

      {business && <>
        {!!business.missingRequired.length && (
          <div className='frd-diag-missing'>
            <Typography.Text type='warning'>待补资料：</Typography.Text>
            <ul>{business.missingRequired.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
        <div className='frd-diag-links'>
          {business.resourceId && <span>关联资源：<code>{business.resourceId}</code></span>}
          {business.resourceUrl && <a href={business.resourceUrl} target='_blank' rel='noreferrer'>资源页面</a>}
          {business.receiptUrl && <a href={business.receiptUrl} target='_blank' rel='noreferrer'>业务回执</a>}
          {businessRunId && <Link to={`/runs/${encodeURIComponent(businessRunId)}`}>关联 Book 运行</Link>}
        </div>
      </>}

      {resumeNotice && <Alert type='warning' showIcon message={resumeNotice} />}

      {!snapshotAvailable && <p className='frd-muted'>运行快照不可用，无法还原分支判断。</p>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--c-line)' }}>
        <span style={{ fontSize: 11, color: 'var(--c-ink-3)' }}>技术状态 {FLOW_STATUS_LABELS[run.status] ?? run.status}</span>
        <Button size='small' icon={<DownloadOutlined />} onClick={() => {
          const archive = exportFlowDiagnostics(run);
          const url = URL.createObjectURL(new Blob([archive], { type: 'application/json;charset=utf-8' }));
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `flow-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-diagnostics-redacted.json`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }}>下载诊断归档</Button>
      </div>
    </div>
  );
}

/** 完整诊断摘要（供 flow 编辑器侧边栏使用） */
export function FlowRunSummary({ run }: { run: FlowRunRow }) {
  const model = useMemo(() => deriveFlowDiagnostics(run), [run]);
  const archive = useMemo(() => exportFlowDiagnostics(run), [run]);
  const { business, branches, timings, snapshotAvailable, resumeNotice, run: diagRun } = model;
  const businessTone = business ? (BUSINESS_TONE[business.level ?? 'info'] ?? BUSINESS_TONE.info) : null;
  const BusinessIcon = businessTone?.icon ?? InfoCircleOutlined;

  const download = () => {
    const url = URL.createObjectURL(new Blob([archive], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `flow-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-diagnostics-redacted.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <section className='frd-summary' aria-label='运行结果与诊断'>
    <div className='frd-diag-banner' style={{ ['--tone' as string]: businessTone?.color ?? 'var(--c-ink-3)' }}>
      <BusinessIcon className='frd-diag-banner-icon' style={{ color: businessTone?.color }} />
      <div className='frd-diag-banner-main'>
        <span className='frd-diag-banner-label'>业务结果</span>
        <span className='frd-diag-banner-value'>{business ? business.label ?? business.status : '业务结果尚未确定'}</span>
      </div>
    </div>

    {diagRun.errorMessage && <RunErrorNote message={diagRun.errorMessage} nodeLabel={model.failedNodeLabel} />}

    {business && <>
      <p className='frd-diag-banner-reason'>{business.reason}</p>
      {!!business.missingRequired.length && (
        <div className='frd-diag-missing'>
          <Typography.Text type='warning'>待补资料：</Typography.Text>
          <ul>{business.missingRequired.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
      <div className='frd-diag-links'>
        {business.resourceId && <span>关联资源：<code>{business.resourceId}</code></span>}
        {business.resourceUrl && <a href={business.resourceUrl} target='_blank' rel='noreferrer'>资源页面</a>}
        {business.receiptUrl && <a href={business.receiptUrl} target='_blank' rel='noreferrer'>业务回执</a>}
      </div>
    </>}

    {resumeNotice && <Alert type='warning' showIcon message={resumeNotice} />}
    {!snapshotAvailable && <p className='frd-muted'>运行快照不可用，无法还原分支判断。</p>}

    {branches.map((branch) => <BranchConditions key={branch.key} branch={branch} label={branch.label} />)}
    {timings.map((timing) => <PhaseTimings key={timing.key} timing={timing} />)}

    <details className='frd-preview'><summary>诊断预览（已脱敏）</summary><ContentView value={archive} contentType='application/json' /></details>
    <Button size='small' icon={<DownloadOutlined />} onClick={download}>下载诊断归档</Button>
  </section>;
}
