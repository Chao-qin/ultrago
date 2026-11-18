import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Descriptions, Drawer, Empty, Space, Tag, Tooltip, Typography, message } from "antd";
import dayjs from "dayjs";
import { Activity, ArrowUpRight, CheckCheck, Clock3, Coins, KeyRound, Radio, RefreshCw, Settings2, Zap } from 'lucide-react';

import { api } from "../lib/api";
import type { LlmCallRow } from '../lib/types';
import { PageTable } from "../components/PageTable";
import { FilterBar } from "../components/FilterBar";
import { SearchInput } from "../components/SearchInput";
import { BcpSelect } from "../components/BcpSelect";
import { DeletedToggle } from "../components/DeletedToggle";
import { LlmChannelEditor } from "../components/LlmChannelEditor";
import { formatCost, formatCount, formatDuration } from "../lib/format";
import { RowActions, ROW_ACTIONS_COLUMN } from "../components/RowActions";
import { LlmAccessEditor } from "../components/LlmAccessEditor";
import { ChannelHealth, CallDistribution, MetricCard, channelLabel } from './llm-dashboard-panels';
import { NumberTicker } from '../components/magicui/number-ticker';
import { ServiceRecoveryPanel } from '../components/service-recovery-panel';
import './dashboard.css';
import "./llm.css";

const { Text, Paragraph } = Typography;

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "ok", label: "成功" },
  { value: "error", label: "失败" },
];

const TIME_RANGES = [
  { value: 0, label: '全部时间' },
  { value: 1, label: '近 24 小时' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
];

export function Llm() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("");
  const [caller, setCaller] = useState("");
  const [status, setStatus] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [detail, setDetail] = useState<LlmCallRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [access, setAccess] = useState(false);
  const [days, setDays] = useState(0);
  const [since, setSince] = useState<string>();
  const overviewQuery = useMemo(() => ({ since }), [since]);
  const timeLabel = TIME_RANGES.find((range) => range.value === days)?.label ?? '全部时间';

  const query = useMemo(
    () => ({
      search: search || undefined,
      channel: channel || undefined,
      caller: caller || undefined,
      status: status || undefined,
      includeDeleted,
      since,
    }),
    [search, channel, caller, status, includeDeleted, since],
  );

  // 渠道现问网关，不落库——配置的真相源是 packages/llm/channels.json。
  // 15s 轮询：健康状态过期比多打几次便宜。
  const channels = useQuery({
    queryKey: ["llm-channels"],
    queryFn: () => api.listLlmChannels(),
    refetchInterval: 15_000,
  });
  const calls = useQuery({
    queryKey: ["llm-calls", query, page, pageSize],
    queryFn: () => api.listLlmCalls({ ...query, page, pageSize }),
    refetchInterval: 30_000,
  });
  const stats = useQuery({
    queryKey: ["llm-call-stats", overviewQuery],
    queryFn: () => api.llmCallStats(overviewQuery),
    refetchInterval: 30_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["llm-calls"] });
    void qc.invalidateQueries({ queryKey: ["llm-call-stats"] });
  };
  const del = useMutation({
    mutationFn: (id: string) => api.deleteLlmCall(id),
    onSuccess: () => { invalidate(); message.success("已删除"); },
    onError: (e: Error) => message.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreLlmCall(id),
    onSuccess: () => { invalidate(); message.success("已恢复"); },
    onError: (e: Error) => message.error(e.message),
  });

  // 筛选按渠道调试名匹配，所以下拉给的是「模型名@来源」的完整值。
  const channelOptions = [
    { value: "", label: "全部模型" },
    ...Array.from(new Map([
      ...(channels.data ?? []).map((c) => [channelLabel(c), c.id] as const),
      ...(stats.data?.byChannel ?? []).map((c) => [c.channel, c.channel.split('@')[0]] as const),
      ...(channel ? [[channel, channel.split('@')[0]] as const] : []),
    ]), ([value, label]) => ({ value, label })),
  ];

  // 调用方选项只能来自统计（网关不知道谁在调它）。当前筛选值兜底进去，
  // 免得筛着筛着时间范围一换、这一项从下拉里消失。
  const callerOptions = [
    { value: "", label: "全部调用方" },
    ...Array.from(
      new Map([
        ...(stats.data?.byCaller ?? []).map((c) => [c.caller, c.caller] as const),
        ...(caller ? [[caller, caller] as const] : []),
      ]),
      ([value, label]) => ({ value, label }),
    ),
  ];

  const columns = [
    {
      title: "时间",
      dataIndex: "startedAt",
      width: 145,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format("YYYY-MM-DD HH:mm:ss")}>
          <Text type="secondary">{dayjs(v).format("MM-DD HH:mm:ss")}</Text>
        </Tooltip>
      ),
    },
    {
      title: "模型",
      dataIndex: "channel",
      width: 190,
      ellipsis: true,
      // channel 存的是渠道调试名（`模型名@来源主机`），前缀就是调用方写的模型名。
      render: (v: string, row: LlmCallRow) => (
        <Space size={4} className="llm-model-cell">
          <Tag className="llm-model-tag" title={String(v).split('@')[0]}>{String(v).split('@')[0]}</Tag>
          {row.stream && <Tag>流式</Tag>}
          {row.deletedAt && <Tag color="red">已删除</Tag>}
        </Space>
      ),
    },
    {
      title: "渠道",
      dataIndex: "channel",
      width: 190,
      ellipsis: true,
      // 同名模型配了多条来源时，只有这一列能回答"这次是哪条服务的"。
      render: (v: string, row: LlmCallRow) => (
        <Tooltip title={`${v} · ${row.adapter} · 上游模型 ${row.model}`}>
          <Text type="secondary" className="llm-cell-clamp" style={{ fontSize: 12 }}>
            {v}{row.adapter ? ` · ${row.adapter}` : ""}
          </Text>
        </Tooltip>
      ),
    },
    {
      // 唯一能回答「**哪条流程**在超时 / 在烧钱」的一列。模型和渠道回答的是
      // 「打给谁」，在它之前 captcha / 预处理 / console 流程是混在一起的。
      title: "调用方",
      dataIndex: "caller",
      width: 150,
      ellipsis: true,
      render: (v: string | null) =>
        v ? (
          <Tag className="llm-model-tag" title={v}>{v}</Tag>
        ) : (
          <Tooltip title="这次调用没带 X-BCP-Caller"><Text type="secondary">—</Text></Tooltip>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 95,
      render: (v: string, row: LlmCallRow) => (
        <Space size={4}>
          {v === "error" ? (
            <Tooltip title={row.errorMessage ?? ""}>
              <Tag color="red">{row.httpStatus ?? '失败'}</Tag>
            </Tooltip>
          ) : (
            <Tag color="green">{row.httpStatus ?? '成功'}</Tag>
          )}
          {/* 第 2 次以后的尝试标出来：一条被 failover 救回来的调用，和一条
              一次就成的调用，在运维上完全是两回事。 */}
          {row.attempt != null && row.attempt > 1 && (
            <Tooltip title={`这是第 ${row.attempt} 次尝试（前面的渠道失败了）`}>
              <Tag color="orange">#{row.attempt}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "耗时",
      dataIndex: "latencyMs",
      width: 110,
      render: (v: number | null, row: LlmCallRow) => (
        <Space size={4}>
          <Text>{formatDuration(v)}</Text>
          {row.ttfbMs != null && (
            <Tooltip title="首帧耗时">
              <Text type="secondary" style={{ fontSize: 12 }}>／{formatDuration(row.ttfbMs)}</Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Token',
      dataIndex: "totalTokens",
      width: 100,
      // null 显示 — 而不是 0：opencode 一个 token 都不报，那和"用了 0 个"是两件事。
      render: (v: number | null, row: LlmCallRow) =>
        v == null ? (
          <Tooltip title="该上游不报 usage"><Text type="secondary">—</Text></Tooltip>
        ) : (
          <Tooltip title={`提示 ${row.promptTokens ?? "?"} / 补全 ${row.completionTokens ?? "?"}`}>
            <Text>{formatCount(v)}</Text>
          </Tooltip>
        ),
    },
    {
      title: "花费",
      dataIndex: "costMicros",
      width: 110,
      // null 是**算不出来**（渠道没填单价 / 上游不报 usage），不是免费。
      render: (v: number | null, row: LlmCallRow) =>
        v == null ? (
          <Tooltip title="这条渠道没填单价，或上游不报 usage"><Text type="secondary">—</Text></Tooltip>
        ) : (
          <Text>{formatCost(v, row.costCurrency)}</Text>
        ),
    },
    {
      title: "内容",
      dataIndex: "requestPreview",
      width: 340,
      ellipsis: true,
      render: (v: string | null, row: LlmCallRow) => {
        const preview = v || row.errorMessage || "(无预览)";
        return (
          <Tooltip title={<div className="llm-preview-tooltip">{preview}</div>} trigger={['hover', 'focus']} styles={{ root: { maxWidth: 'min(560px, calc(100vw - 32px))' } }}>
            <button type="button" className="llm-call-preview" onClick={() => setDetail(row)}>{preview}</button>
          </Tooltip>
        );
      },
    },
    {
      ...ROW_ACTIONS_COLUMN,
      width: 152,
      render: (_: unknown, row: LlmCallRow) => (
        <RowActions
          actions={[
            { key: "detail", label: "详情", onClick: () => setDetail(row) },
            row.deletedAt
              ? { key: "restore", label: "恢复", onClick: () => restore.mutate(row.id) }
              : {
                  key: "delete",
                  label: "删除",
                  danger: true,
                  confirm: { title: "删除这条记录？", description: "可在「含已删除」里恢复" },
                  onClick: () => del.mutate(row.id),
                },
          ]}
        />
      ),
    },
  ];

  const gatewayDown = channels.isError;
  const downCount = (channels.data ?? []).filter((c) => c.health === "down").length;
  const onlineCount = (channels.data ?? []).filter((c) => c.health === "ok").length;
  const metrics = stats.isError ? undefined : stats.data;
  const total = metrics?.total;
  const errors = metrics?.errors;
  const successRate = total ? ((total - (errors ?? 0)) / total) * 100 : null;
  const usageReported = metrics?.byChannel.some((item) => item.totalTokens != null);
  // 花费按货币分开来，永远不合成一个数 —— USD 和 CNY 加起来看着正常却毫无意义，
  // 而汇率不是这个系统该知道的东西。卡片显示最大的那笔，其余落到脚注里。
  const costs = metrics?.costByCurrency ?? [];
  const [primaryCost, ...otherCosts] = costs;
  const costValue = primaryCost ? formatCost(primaryCost.costMicros, primaryCost.currency) : '—';
  const costNote = !primaryCost
    ? total
      ? '该范围内的渠道未声明单价'
      : '按渠道单价 × 用量核算'
    : otherCosts.length
      ? `另有 ${otherCosts.map((c) => formatCost(c.costMicros, c.currency)).join(' · ')}`
      : `${formatCount(primaryCost.count)} 次调用可核算`;
  const busy = channels.isFetching || calls.isFetching || stats.isFetching;
  const selectChannel = (value: string) => { setChannel(value === channel ? '' : value); setPage(1); };
  const refresh = () => {
    if (days) setSince(dayjs().subtract(days, 'day').toISOString());
    invalidate();
    void channels.refetch();
  };
  const gatewayLabel = channels.isPending ? '正在连接' : gatewayDown ? '连接异常' : channels.data?.length ? '网关在线' : '暂无可用渠道';
  const filtered = Boolean(search || channel || caller || status || includeDeleted);

  return (
    <div className="mc-root llm-page page-fill">
      <div className="llm-ambient" aria-hidden="true">
        <div className="mc-aurora mc-aurora-a" />
        <div className="mc-aurora mc-aurora-b" />
      </div>
      <header className="mc-hud llm-header">
        <div className="llm-heading">
          <span className="llm-eyebrow"><i />AI INFRASTRUCTURE</span>
          <div className="llm-title-line"><h1 className="mc-hud-name">LLM GATEWAY</h1><span className="llm-heading-caption">模型运行指挥舱</span><span className={`llm-gateway-status${gatewayDown ? ' is-error' : channels.isPending || !channels.data?.length ? ' is-unknown' : ''}`}><i />{gatewayLabel}</span></div>
          <p className="llm-heading-description">统一监控模型流量、渠道健康与访问策略</p>
        </div>
        <div className="llm-header-actions">
          <Tooltip title="调用与用量每 30 秒刷新，渠道健康每 15 秒探测"><span className="llm-sync"><Radio size={13} />{stats.dataUpdatedAt ? dayjs(stats.dataUpdatedAt).format('HH:mm:ss') : '等待数据'}</span></Tooltip>
          <div className="llm-action-row">
            <BcpSelect aria-label="统计时间范围" className="llm-time-range" showSearch={false} value={days} options={TIME_RANGES} onChange={(value: number) => { setDays(value); setSince(value ? dayjs().subtract(value, 'day').toISOString() : undefined); setPage(1); }} />
            <Button aria-label="刷新仪表盘" icon={<RefreshCw size={15} className={busy ? 'llm-spinning' : ''} />} onClick={refresh} disabled={busy} />
            <Button icon={<KeyRound size={15} />} onClick={() => setAccess(true)}>访问与限流</Button>
            <Button type="primary" icon={<Settings2 size={15} />} onClick={() => setEditing(true)}>渠道管理</Button>
          </div>
        </div>
      </header>
      <nav className="llm-workspace-switcher" aria-label="模型工作区快捷入口">
        <button type="button" onClick={() => { const target = document.getElementById('llm-overview-section'); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start' }); }}><Activity size={15} aria-hidden="true" />用量总览</button>
        <button type="button" onClick={() => { const target = document.getElementById('llm-calls-section'); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start' }); }}><Radio size={15} aria-hidden="true" />调用记录</button>
        <span />
        <button type="button" onClick={() => setEditing(true)}><Settings2 size={15} aria-hidden="true" />渠道配置</button>
        <button type="button" onClick={() => setAccess(true)}><KeyRound size={15} aria-hidden="true" />访问策略</button>
      </nav>

      {(gatewayDown || stats.isError) && <ServiceRecoveryPanel
        compact
        title={gatewayDown ? '部分服务暂时离线' : '统计数据暂时不可用'}
        description="各服务独立连接，可用的调用记录和操作仍保留在下方。"
        issues={[
          ...(gatewayDown ? [{ id: 'gateway', label: '网关连接异常', error: channels.error, description: '渠道健康暂时不可用，历史调用记录不受影响。' }] : []),
          ...(stats.isError ? [{ id: 'statistics', label: '统计数据加载失败', error: stats.error, description: '用量与成功率暂时不可用，恢复后将显示真实指标。' }] : []),
        ]}
        retryLabel="重新连接"
        retrying={busy}
        onRetry={() => Promise.all([channels.refetch(), stats.refetch(), calls.refetch()])}
      />}
      <div className="llm-metrics" id="llm-overview-section" tabIndex={-1}>
        <MetricCard label="总调用量" caption="TOTAL REQUESTS" value={total == null ? '—' : <NumberTicker value={total} />} icon={<Activity size={19} />} note={`${timeLabel} · 全部渠道（不含已删除）`} featured loading={stats.isPending} />
        <MetricCard label="调用成功率" caption="SUCCESS RATE" value={successRate == null ? '—' : <NumberTicker value={successRate} decimalPlaces={1} suffix="%" />} icon={<CheckCheck size={19} />} note={errors == null ? '等待统计数据' : `${formatCount(errors)} 次失败 / ${formatCount(total ?? 0)} 次调用`} bad={Boolean(errors)} loading={stats.isPending} progress={successRate} />
        <MetricCard label="P95 响应耗时" caption="LATENCY" value={formatDuration(metrics?.p95LatencyMs)} icon={<Clock3 size={19} />} note="95% 的已记录耗时不超过此值" loading={stats.isPending} />
        <MetricCard label="Token 消耗" caption="TOKEN USAGE" value={metrics ? usageReported ? formatCount(metrics.totalTokens) : total === 0 ? '0' : '—' : '—'} icon={<Zap size={19} />} note={total && !usageReported ? '该范围内的上游未报告用量' : '已报告用量 · 提示 + 补全'} loading={stats.isPending} />
        <MetricCard label="花费" caption="COST" value={costValue} icon={<Coins size={19} />} note={costNote} loading={stats.isPending} />
      </div>

      <div className="llm-analysis-grid">
        <CallDistribution stats={metrics} loading={stats.isPending} failed={stats.isError} selected={channel} onSelect={selectChannel} timeLabel={timeLabel} />
        <section className="mc-glass llm-panel llm-health-panel">
          <div className="llm-panel-heading"><div><h2>渠道状态与用量</h2><p>{timeLabel} · 已报告 Token</p></div><Tooltip title="实时探测服务可达性，不代表模型调用一定成功；调用失败数见各渠道卡片。"><span className="llm-health-summary"><b>{channels.isPending || gatewayDown ? '—' : onlineCount}</b> / {channels.data?.length ?? '—'} 服务可达{downCount > 0 && <em>{downCount} 异常</em>}</span></Tooltip></div>
          <ChannelHealth channels={channels.data} stats={metrics} loading={channels.isPending} failed={gatewayDown} selected={channel} onSelect={selectChannel} timeLabel={timeLabel} />
          <div className="llm-panel-footnote">健康状态实时探测 · 点击卡片仅筛选下方记录</div>
        </section>
      </div>

      <section className="mc-glass llm-panel llm-table-panel" id="llm-calls-section" tabIndex={-1}>
        <div className="llm-panel-heading"><div><h2><span className="llm-section-icon"><Activity size={16} /></span>调用记录 <span className="llm-count">{calls.data ? formatCount(calls.data.total) : '—'}</span></h2><p>{timeLabel} · 下方筛选仅影响调用记录</p></div><div className="llm-table-heading-actions">{channel && <div className="llm-record-scope" role="status"><span title={channel}>已筛选 <strong>{channel}</strong></span><Button type="text" size="small" aria-label="取消渠道筛选" onClick={() => selectChannel(channel)}>取消</Button></div>}<span className="llm-detail-hint">点击内容查看详情 <ArrowUpRight size={14} /></span></div></div>
        <FilterBar>
          <SearchInput
            value={search}
            onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="搜索提示词 / 回答 / 报错…"
          />
          <BcpSelect
            aria-label="筛选渠道"
            options={channelOptions}
            value={channel}
            onChange={(v) => { setChannel(v ?? ""); setPage(1); }}
            style={{ width: 200 }}
          />
          <BcpSelect
            aria-label="筛选调用方"
            options={callerOptions}
            value={caller}
            onChange={(v) => { setCaller(v ?? ""); setPage(1); }}
            style={{ width: 170 }}
          />
          <BcpSelect
            aria-label="筛选状态"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => { setStatus(v ?? ""); setPage(1); }}
            style={{ width: 120 }}
          />
          <DeletedToggle checked={includeDeleted} onChange={(v) => { setIncludeDeleted(v); setPage(1); }} />
          {filtered && <Button type="text" size="small" onClick={() => { setSearch(''); setChannel(''); setCaller(''); setStatus(''); setIncludeDeleted(false); setPage(1); }}>清除筛选</Button>}
        </FilterBar>

        <PageTable
          dataSource={calls.data?.items ?? []}
          columns={columns}
          rowKey="id"
          query={calls}
          empty={{ title: "还没有调用记录", description: "网关服务过的每一次请求都会记在这里。" }}
          size="middle"
          scroll={{ x: 1582 }}
          pagination={{
            current: calls.data?.page ?? page,
            pageSize: calls.data?.pageSize ?? pageSize,
            total: calls.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
        />
      </section>

      <CallDrawer row={detail} onClose={() => setDetail(null)} />
      <LlmChannelEditor open={editing} onClose={() => setEditing(false)} />
      <LlmAccessEditor open={access} onClose={() => setAccess(false)} />
    </div>
  );
}


function CallDrawer({ row, onClose }: { row: LlmCallRow | null; onClose: () => void }) {
  return (
    <Drawer title="调用详情" width="min(720px, 100vw)" open={!!row} onClose={onClose} destroyOnClose>
      {!row ? (
        <Empty />
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="调用方写的模型">{String(row.channel).split("@")[0]}</Descriptions.Item>
            <Descriptions.Item label="适配器">{row.adapter}</Descriptions.Item>
            <Descriptions.Item label="哪条渠道服务的">{row.channel}</Descriptions.Item>
            <Descriptions.Item label="上游模型">{row.model}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={row.status === "error" ? "red" : "green"}>{row.httpStatus ?? row.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="流式">{row.stream ? "是" : "否"}</Descriptions.Item>
            <Descriptions.Item label="调用方">
              {row.caller ?? <Text type="secondary">未带 X-BCP-Caller</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="第几次尝试">
              {row.attempt == null
                ? <Text type="secondary">—</Text>
                : row.attempt > 1
                  ? `第 ${row.attempt} 次（前面的渠道失败了）`
                  : "第 1 次"}
            </Descriptions.Item>
            <Descriptions.Item label="耗时">{formatDuration(row.latencyMs)}</Descriptions.Item>
            <Descriptions.Item label="首帧">{formatDuration(row.ttfbMs)}</Descriptions.Item>
            <Descriptions.Item label="token">
              {row.totalTokens == null
                ? "该上游不报 usage"
                : `${row.totalTokens}（提示 ${row.promptTokens ?? "?"} / 补全 ${row.completionTokens ?? "?"}）`}
            </Descriptions.Item>
            <Descriptions.Item label="花费">
              {row.costMicros == null
                ? <Text type="secondary">这条渠道没填单价，或上游不报 usage</Text>
                : formatCost(row.costMicros, row.costCurrency)}
            </Descriptions.Item>
            {/* 两个时钟分开列：差值本身是排查时序问题的线索 */}
            <Descriptions.Item label="发起（网关钟）">
              {dayjs(row.startedAt).format("YYYY-MM-DD HH:mm:ss.SSS")}
            </Descriptions.Item>
            <Descriptions.Item label="落库（console 钟）">
              {dayjs(row.receivedAt).format("YYYY-MM-DD HH:mm:ss.SSS")}
            </Descriptions.Item>
          </Descriptions>

          {row.errorMessage && (
            <Alert type="error" showIcon message={row.errorKind ?? "错误"} description={row.errorMessage} />
          )}

          <div>
            <Text strong>提示词</Text>
            <Paragraph copyable={{ text: row.requestPreview ?? "" }} style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
              {row.requestPreview ?? <Text type="secondary">(无)</Text>}
            </Paragraph>
          </div>
          <div>
            <Text strong>回答</Text>
            <Paragraph copyable={{ text: row.responsePreview ?? "" }} style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
              {row.responsePreview ?? <Text type="secondary">(无)</Text>}
            </Paragraph>
          </div>
        </Space>
      )}
    </Drawer>
  );
}
