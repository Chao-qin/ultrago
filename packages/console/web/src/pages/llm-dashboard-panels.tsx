import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Skeleton, Tooltip } from 'antd';
import { ArrowRight, BarChart3, ChartPie, Server, Unplug } from 'lucide-react';
import type { LlmCallStats, LlmChannelView } from '../lib/types';
import { formatCost, formatCount } from '../lib/format';
import { MagicCard } from '../components/magicui/magic-card';
import { BorderBeam } from '../components/magicui/border-beam';

const HEALTH: Record<string, { label: string; className: string }> = {
  ok: { label: '服务可达', className: 'is-ok' },
  down: { label: '不可达', className: 'is-error' },
  unknown: { label: '无法探测', className: 'is-unknown' },
};

// 历史记录按「模型@主机」存储，筛选值必须与网关的 channelLabel 保持一致。
export function channelLabel(channel: Pick<LlmChannelView, 'id' | 'adapter' | 'baseUrl'>): string {
  if (!channel.baseUrl) return `${channel.id}@${channel.adapter}`;
  try {
    return `${channel.id}@${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.id}@${channel.baseUrl}`;
  }
}

export function MetricCard({ label, caption, value, icon, note, featured, bad, loading, progress }: {
  label: string;
  caption: string;
  value: ReactNode;
  icon: ReactNode;
  note: string;
  featured?: boolean;
  bad?: boolean;
  loading: boolean;
  progress?: number | null;
}) {
  return (
    <MagicCard className="llm-metric-card">
    <article className={`mc-glass llm-metric${featured ? ' is-featured' : ''}${bad ? ' has-errors' : ''}`} aria-label={label} aria-busy={loading}>
      <div className="llm-metric-top"><span>{label}</span><span className={`llm-metric-icon${progress != null ? ' has-progress' : ''}`} style={progress != null ? { background: `conic-gradient(var(--c-ok) ${progress}%, var(--c-subtle) 0)` } : undefined} aria-hidden="true"><span>{icon}</span></span></div>
      {loading ? <Skeleton.Input active size="small" /> : <div className="llm-metric-value">{value}</div>}
      <div className="llm-metric-footer"><span>{note}</span><span className="llm-metric-caption">{caption}</span></div>
    </article>
    {featured && <BorderBeam />}
    </MagicCard>
  );
}

type SelectionProps = { selected: string; onSelect: (channel: string) => void; timeLabel: string };

const DISTRIBUTION_COLORS = ['#8b7cf8', '#38bdb2', '#5ba6ed', '#f0b35b', '#de83bb', '#a3b85c', '#f08372', '#8a9cb9', '#ad87d2'];

export function CallDistribution({ stats, loading, failed, selected, onSelect, timeLabel }: SelectionProps & {
  stats: LlmCallStats | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const rows = [...(stats?.byChannel ?? [])].sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
  const total = stats?.total ?? 0;
  const focused = rows.find((row) => row.channel === (hovered ?? selected));
  let offset = 0;
  return (
    <section className="mc-glass llm-panel llm-distribution-panel" aria-busy={loading}>
      <div className="llm-panel-heading">
        <div><h2><ChartPie size={15} />模型用量分布 <span className="llm-count">{rows.length}</span></h2><p>{timeLabel} · 按调用次数统计</p></div>
        <span className="llm-distribution-badge">调用占比</span>
      </div>
      {loading ? <Skeleton active paragraph={{ rows: 3 }} title={false} /> : rows.length ? (
        <div className="llm-distribution-body">
          <div className="llm-donut-summary">
            <div className="llm-donut-stage">
            <div className="llm-donut">
              <svg viewBox="0 0 200 200" role="img" aria-label={`调用占比分布：${rows.map((row) => `${row.channel} ${(total ? row.count / total * 100 : 0).toFixed(1)}%`).join('，')}`}>
                <circle className="llm-donut-base" cx="100" cy="100" r="78" fill="none" strokeWidth="19" />
                {rows.map((row, index) => {
                  const share = total ? row.count / total * 100 : 0;
                  const start = offset;
                  offset += share;
                  return <circle key={`${row.channel}:${row.adapter}`} className="llm-donut-segment" cx="100" cy="100" r="78" fill="none" stroke={DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length]} strokeWidth={focused?.channel === row.channel ? 24 : 19} pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 100 100)" opacity={focused && focused.channel !== row.channel ? .3 : 1} onMouseEnter={() => setHovered(row.channel)} onMouseLeave={() => setHovered(null)}><title>{row.channel} · {formatCount(row.count)} 次调用 · {share.toFixed(1)}%</title></circle>;
                })}
              </svg>
              <div className="llm-donut-center"><span>{focused ? '调用占比' : '总调用次数'}</span><b>{focused ? `${(total ? focused.count / total * 100 : 0).toFixed(1)}%` : formatCount(total)}</b><small title={focused?.channel}>{focused ? focused.channel.split('@')[0] : `${rows.length} 个模型 / 渠道`}</small></div>
            </div>
            </div>
            <div className="llm-donut-caption"><span className="llm-overline">{focused ? '当前关注' : '调用最多'}</span><strong title={(focused ?? rows[0]).channel}>{(focused ?? rows[0]).channel.split('@')[0]}</strong><span>{formatCount((focused ?? rows[0]).count)} 次调用 <i>·</i> {((focused ?? rows[0]).count / (total || 1) * 100).toFixed(1)}%</span></div>
          </div>
          <div className="llm-distribution-wrap">
        <div className="llm-distribution-columns" aria-hidden="true"><span>模型 / 渠道排行</span><span>调用 / 占比</span><span>已报告 Token</span></div>
        <div className="llm-distribution" role="list" aria-label="各模型调用量及 Token 用量">
          {rows.map((row, index) => {
            const percent = total ? (row.count / total) * 100 : 0;
            const source = row.channel.includes('@') ? row.channel.slice(row.channel.indexOf('@') + 1) : row.adapter;
            return (
              <div role="listitem" key={`${row.channel}:${row.adapter}`}>
                <Tooltip title={`${row.channel} · ${row.adapter} · 成功 ${formatCount(row.count - row.errors)} 次 / 失败 ${formatCount(row.errors)} 次 · 调用占比 ${percent.toFixed(1)}% · Token ${row.totalTokens == null ? '未上报' : formatCount(row.totalTokens)} · 点击仅筛选下方调用记录`}>
                  <button type="button" className={`llm-distribution-row${selected === row.channel ? ' is-selected' : ''}`} style={{ '--row-color': DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length] } as CSSProperties} aria-label={`${selected === row.channel ? '取消筛选' : '查看调用记录'}：${row.channel}`} aria-pressed={selected === row.channel} onClick={() => onSelect(row.channel)} onMouseEnter={() => setHovered(row.channel)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(row.channel)} onBlur={() => setHovered(null)}>
                    <span className="llm-distribution-name"><span className="llm-rank-number">{String(index + 1).padStart(2, '0')}</span><span className="llm-rank-model"><strong>{row.channel.split('@')[0]}</strong><small>{source}</small></span></span>
                    <span className="llm-distribution-count"><b>{formatCount(row.count)}</b><small>{percent.toFixed(1)}%</small></span>
                    <span className={`llm-distribution-tokens${row.totalTokens == null ? ' is-unknown' : ''}`}>{row.totalTokens == null ? '未上报' : formatCount(row.totalTokens)}</span>
                    <span className="llm-rank-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
        </div>
        </div>
      ) : <div className="llm-panel-empty"><BarChart3 size={28} /><span>{failed ? '统计暂时不可用' : '该时间范围内暂无调用'}</span><small>{failed ? '请在上方重试加载统计数据' : '调用发生后，分布将显示在这里'}</small></div>}
      <div className="llm-panel-footnote">环形图与排行颜色对应 · 点击排行仅筛选下方记录</div>
    </section>
  );
}

export function ChannelHealth({ channels, stats, loading, failed, selected, onSelect, timeLabel }: SelectionProps & {
  channels: LlmChannelView[] | undefined;
  stats: LlmCallStats | undefined;
  loading: boolean;
  failed: boolean;
}) {
  if (loading) return <Skeleton active paragraph={{ rows: 3 }} title={false} />;
  if (failed || !channels?.length) return <div className="llm-panel-empty"><Unplug size={28} /><span>{failed ? '渠道状态暂时不可用' : '暂无可用渠道'}</span><small>请检查网关连接与渠道配置</small></div>;
  return (
    <div className="llm-channel-grid">
      {channels.map((channel) => {
        const health = HEALTH[channel.health] ?? HEALTH.unknown;
        const label = channelLabel(channel);
        const usage = stats?.byChannel.find((row) => row.channel === label && row.adapter === channel.adapter);
        const tokens = usage?.totalTokens;
        const tokenLabel = !stats ? '—' : !usage ? '0' : tokens == null ? '未上报' : formatCount(tokens);
        const tokenShare = stats?.totalTokens && tokens != null ? (tokens / stats.totalTokens) * 100 : 0;
        // 花费同样按渠道给，但**不跨货币相加**：卡片只显示这条渠道自己的那笔。
        const cost = usage?.costMicros;
        return (
          <Tooltip key={label} title={<><div>渠道：{channel.id} · 上游模型：{channel.model}</div><div>{channel.baseUrl || '本地 CLI'}</div><div>实时探测：{channel.healthDetail || health.label}（不代表调用成功率）</div><div>{timeLabel} · {usage ? `${formatCount(usage.count)} 次调用 / ${formatCount(usage.errors)} 次失败` : stats ? '暂无调用' : '统计暂不可用'}</div>{tokens != null && <div>占全部已报告 Token 的 {tokenShare.toFixed(1)}%</div>}{usage && tokens == null && <div>该时间范围内的调用记录没有 Token 用量数据</div>}<div>点击仅筛选下方调用记录，再次点击取消</div></>}>
            <button type="button" className={`llm-channel-card${selected === label ? ' is-selected' : ''}`} aria-label={`${selected === label ? '取消筛选' : '查看调用记录'}：${channel.id}`} aria-pressed={selected === label} onClick={() => onSelect(label)}>
              <div className="llm-channel-top"><span className="llm-channel-adapter"><Server size={13} />{channel.adapter}</span><span className={`llm-health-state ${health.className}`}><i />{health.label}</span></div>
              <div className="llm-channel-name">{channel.id}</div>
              {/* 能力标签是**人工声明**的（网关不据它路由、也不据它拒请求），
                  所以只作为一行说明摆在这里，不参与任何判断。 */}
              {channel.capabilities.length > 0 && (
                <div className="llm-channel-caps">{channel.capabilities.join(' · ')}</div>
              )}
              <div className="llm-channel-bottom"><span className="llm-channel-usage"><b>{tokenLabel}</b><small>Token</small></span>{cost != null && <span className="llm-channel-usage"><b>{formatCost(cost)}</b><small>花费</small></span>}</div>
              <div className="llm-channel-calls">{usage ? <><span>{formatCount(usage.count)} 次调用</span><span className={usage.errors ? 'has-failures' : ''}>{formatCount(usage.errors)} 次失败</span></> : <span>{stats ? '暂无调用' : '统计暂不可用'}</span>}</div>
              <div className="llm-channel-action"><span>{selected === label ? '已筛选 · 再点取消' : '查看调用记录'}</span><ArrowRight size={13} /></div>
              <span className="llm-channel-token-track" aria-hidden="true"><span style={{ width: `${tokenShare}%` }} /></span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
