import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import type { EChartsOption } from "echarts";

import { api } from "../lib/api";
import { Chart } from "../components/Chart";
import { formatCount, formatDuration } from "../lib/format";
import { getPalette, paletteDark, useTheme } from "../theme";
import "./dashboard.css";
import { ErrorState } from '../components/EmptyState';
import { MagicCard } from '../components/magicui/magic-card';
import { NumberTicker } from '../components/magicui/number-ticker';
import { BorderBeam } from '../components/magicui/border-beam';
import { fetchDesktopConnections, openDesktopConnections } from '../lib/desktop-connections';

/**
 * Mission Control —— 仪表盘的指挥舱形态。
 *
 * 信息架构沿用上一版的「操作者问题」排序（它是对的，这次只换表达）：
 *   1. 现在还能不能跑  → HUD 状态条
 *   2. 有什么在等我    → KPI 英雄排
 *   3. 跑得怎么样      → 趋势主图
 *   4. 哪里在坏        → 三张健康度榜单（Book / 流程 / LLM 渠道）
 *   5. 接下来跑什么    → 即将触发
 *   6. 刚发生了什么    → 失败流 + 运行流
 *
 * 视觉上是一次明确的换场：console 其余部分是白底账面，这一页是深空面板。
 * 语义色不换——绿仍是成功、红仍是失败，只是提亮到暗底可读（#34D399/#F87171）。
 * 动效全部克制：入场一次、状态点常脉、hover 一道流光；数据本身才是主角。
 */

/** 成功率达标线。低于它就不该是绿色。 */
const SUCCESS_TARGET = 0.9;

const RANGES = [
  { label: "7 天", value: 7 },
  { label: "14 天", value: 14 },
  { label: "30 天", value: 30 },
];

/** 运行结果四色（暗底提亮版，语义与全站一致）。 */
const OUTCOME = {
  success: { label: "成功", color: "#34D399" },
  escalated: { label: "已中止", color: "#A78BFA" },
  failed: { label: "失败", color: "#F87171" },
  other: { label: "其他", color: "rgba(232,237,247,0.28)" },
} as const;

const EVENT_LABEL: Record<string, string> = {
  captcha_appeared: "验证码出现",
  captcha_cleared: "验证码解除",
  browser_offline: "浏览器掉线",
  probe_test: "探针测试",
};

/** 基于 palette 动态生成 Dashboard 整套主题（日夜自动换） */
function buildMC(p: ReturnType<typeof getPalette>) {
  const isDark = p.bg === "#05070F"; // 夜 #05070F vs 日 #F3F5FA
  const ink1 = p.ink1;
  const ink2 = p.ink2;
  const ink3 = p.ink3;
  const line = p.line;
  const cyan = p.info;
  const violet = isDark ? "#A78BFA" : "#7C3AED";
  const warn = p.warn;
  const ok = p.ok;
  const bad = p.bad;

  const OUTCOME_DYN = {
    success: { label: "成功", color: ok },
    escalated: { label: "已中止", color: violet },
    failed: { label: "失败", color: bad },
    other: { label: "其他", color: ink3 },
  };

  return {
    MC: { ink1, ink2, ink3, line, cyan, violet, warn, ok, bad },
    OUTCOME: OUTCOME_DYN,
    IS_DARK: isDark,
    AXIS: {
      category: {
        type: "category" as const,
        axisLine: { lineStyle: { color: isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)" } },
        axisTick: { show: false },
        axisLabel: { color: ink3, fontSize: 11 },
      },
      value: {
        type: "value" as const,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", type: "dashed" as const } },
        axisLabel: { color: ink3, fontSize: 11 },
      },
    },
    TOOLTIP: {
      backgroundColor: isDark ? "rgba(7,11,22,0.94)" : "rgba(255,255,255,0.96)",
      borderWidth: 0,
      padding: [8, 12] as [number, number],
      textStyle: { color: ink1, fontSize: 12 },
      extraCssText: isDark
        ? "border:1px solid rgba(255,255,255,0.12); border-radius:8px; box-shadow:0 12px 32px -8px rgba(0,0,0,.6); backdrop-filter:blur(4px);"
        : "border:1px solid rgba(0,0,0,0.08); border-radius:8px; box-shadow:0 8px 24px -8px rgba(0,0,0,.15); backdrop-filter:blur(4px);",
      axisPointer: { type: "shadow" as const, shadowStyle: { color: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)" } },
    },
    LEGEND: { textStyle: { color: ink3, fontSize: 12 } },
  };
}

/** 暗底坐标轴。ChartImpl 的默认主题是给白底账面用的，这里整套覆写。 */
const MC_AXIS = buildMC(paletteDark).AXIS;

const MC_TOOLTIP = buildMC(paletteDark).TOOLTIP;

const MC_LEGEND = { textStyle: { color: MC_AXIS.category.axisLabel.color, fontSize: 12 } };

export function Dashboard() {
  const [days, setDays] = useState(7);
  const [connectionError, setConnectionError] = useState('');
  const connections = useQuery({ queryKey: ['desktop-connections'], queryFn: fetchDesktopConnections, retry: false, refetchInterval: (query) => query.state.data === null ? false : 5000 });
  const desktop = connections.data;
  const connectedAssistants = desktop?.assistants.filter((agent) => agent.state === 'connected') || [];
  const agentError = desktop?.lastError;
  const { mode } = useTheme();
  const palette = getPalette(mode);
  const { MC, AXIS: MC_AXIS_DYN, TOOLTIP: MC_TOOLTIP_DYN, LEGEND: MC_LEGEND_DYN, OUTCOME: OUTCOME_DYN, IS_DARK } = buildMC(palette);

  const overview = useQuery({
    queryKey: ["overview", days],
    queryFn: () => api.overview(days),
    refetchInterval: 5000,
  });
  // 与上面的 days 同窗口：两组数字写着同一个天数却统计不同区间，是那种没人会
  // 发现的错。
  const since = useMemo(
    () => dayjs().startOf("day").subtract(days - 1, "day").toISOString(),
    [days],
  );
  const llm = useQuery({
    queryKey: ["dashboard-llm", since],
    queryFn: () => api.llmCallStats({ since }),
    refetchInterval: 15_000,
  });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 5000 });
  const events = useQuery({
    queryKey: ["dashboard-events"],
    queryFn: () => api.browserEventStats({}),
    refetchInterval: 10_000,
  });
  const flows = useQuery({
    queryKey: ["flows", false],
    queryFn: () => api.listFlows({ includeDeleted: false }),
    refetchInterval: 30_000,
  });
  const schedules = useQuery({
    queryKey: ["schedules", false],
    queryFn: () => api.listSchedules({ includeDeleted: false }),
    refetchInterval: 30_000,
  });
  // 已中止单独查。overview 的 perDay 只给 count/success/failed，剩下那部分是
  // 「已中止 + 已取消 + 运行中」混在一起——拿它冒充已中止就是贴错标签。
  const escalated = useQuery({
    queryKey: ["dashboard-escalated"],
    queryFn: () => api.listRuns({ status: "escalated", limit: 500 }),
    refetchInterval: 30_000,
  });

  const o = overview.data;

  const failedCount = o ? o.perDay.reduce((n, d) => n + d.failed, 0) : null;
  const windowRuns = o ? o.perDay.reduce((n, d) => n + d.count, 0) : null;
  const successTone: Tone =
    o?.successRate == null ? "idle" : o.successRate >= SUCCESS_TARGET ? "ok" : o.successRate >= 0.5 ? "warn" : "bad";

  const captcha = (events.data?.byKind ?? []).find((k) => k.kind === "captcha_appeared")?.count ?? 0;
  const unacked = events.data?.unacknowledged ?? 0;

  /** Book 健康度：按失败数排，不按运行次数——跑得多且全绿的那个不需要你看。 */
  const bookHealth = useMemo<HealthRow[]>(() => {
    const rows = (o?.topBooks ?? []).map((b) => ({
      id: b.bookId,
      name: b.name,
      runs: b.runs,
      bad: b.successRate == null ? 0 : Math.round(b.runs * (1 - b.successRate)),
      rate: b.successRate,
    }));
    return rows.sort((a, b) => b.bad - a.bad || b.runs - a.runs).slice(0, 6);
  }, [o?.topBooks]);

  /** 流程健康度：flows 列表自带 runs 摘要，成败在前端算。 */
  const flowHealth = useMemo<HealthRow[]>(() => {
    return (flows.data ?? [])
      .map((f) => {
        const runs = f.runs ?? [];
        const good = runs.filter((r) => r.status === "success").length;
        return {
          id: f.id,
          name: f.name,
          runs: runs.length,
          bad: runs.length - good,
          rate: runs.length ? good / runs.length : null,
        };
      })
      .filter((f) => f.runs > 0)
      .sort((a, b) => b.bad - a.bad || b.runs - a.runs)
      .slice(0, 6);
  }, [flows.data]);

  /** LLM 渠道健康度：接口直接给 byChannel。 */
  const channelHealth = useMemo<HealthRow[]>(() => {
    return (llm.data?.byChannel ?? [])
      .map((c) => ({
        id: c.channel,
        name: c.channel.split("@")[0] || c.channel,
        runs: c.count,
        bad: c.errors,
        rate: c.count ? (c.count - c.errors) / c.count : null,
      }))
      .sort((a, b) => b.bad - a.bad || b.runs - a.runs)
      .slice(0, 6);
  }, [llm.data?.byChannel]);

  const upcoming = useMemo(() => {
    const now = dayjs();
    return (schedules.data ?? [])
      .filter((s) => s.enabled && !s.deletedAt)
      .flatMap((s) => (s.nextFires ?? []).map((at) => ({ id: s.id, at, name: s.name, when: relativeFire(now, at) })))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, 5);
  }, [schedules.data]);

  return (
    <div className="mc-root">
      <div className="mc-aurora mc-aurora-a" aria-hidden="true" />
      <div className="mc-aurora mc-aurora-b" aria-hidden="true" />

      {/* HUD：标题 + 实时钟 + 时间窗 */}
      <section className="mc-command-deck" aria-label="运行指挥中心">
      <div className="mc-command-center">
      <div className="mc-hud">
        <div className="mc-hud-title">
          <h1 className="mc-hud-name" style={{ margin: 0 }}>运行概览</h1>
        </div>
        <div className="mc-hud-right">
          <div className="mc-range" role="group" aria-label="统计区间">
            {RANGES.map((r) => (
              <button type="button" key={r.value} aria-pressed={r.value === days} className={r.value === days ? "on" : ""} onClick={() => setDays(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <nav className="mc-deck-links" aria-label="运行快捷入口"><Link to="/runs">运行记录 →</Link><Link to="/flows">流程编排 →</Link><Link to="/schedules">定时任务 →</Link></nav>
      </div>

      {/* 1. 现在还能不能跑。四个二元状态 + 一个计数，不做成图表。 */}
      <div className="mc-strip mc-stagger">
        <Chip ok={health.data?.backend.ok} label="后端" detail={health.data?.backend.ok ? `${health.data.backend.plans ?? 0} 计划` : "未连接"} />
        <Chip ok={health.data?.db} label="数据库" detail={health.data?.db ? "已连接" : "不可用"} />
        {desktop ? <><Chip ok={desktop.browserReady} label="Chrome" detail={desktop.browserReady ? `已确认 · ${desktop.browserId.slice(0, 8)}` : desktop.browserId ? '原浏览器离线' : '等待确认'} /><Chip ok={agentError ? false : connectedAssistants.length > 0 ? true : undefined} label="MCP 助手" detail={agentError ? '连接失败' : connectedAssistants.length ? `${connectedAssistants[0].name}${connectedAssistants[0].toolCount ? ` · ${connectedAssistants[0].toolCount} 工具` : ' · 已握手'}` : desktop.mcpReady ? '等待助手连接' : '服务未就绪'} /></> : <Chip ok={llm.isError ? false : llm.data ? true : undefined} label="调用记录" detail={llm.isError ? '不可达' : llm.data ? `${formatCount(llm.data.total)} 次` : '加载中'} />}
        <Chip ok={overview.isError ? false : o ? true : undefined} label="队列" detail={overview.isError ? '统计不可用' : !o ? '等待数据' : o.runningNow ? `${o.runningNow} 运行中` : '空闲'} />
        {desktop && <button type="button" className="mc-connection-help" onClick={() => { void openDesktopConnections().catch((error) => setConnectionError(error.message)); }}>{desktop.mcpReady && !connectedAssistants.length && !agentError ? '接入 AI 助手 ↗' : '连接诊断 ↗'}</button>}
      </div>
      {(agentError || connectionError || connections.isError) && <p className="mc-connection-error" role="status">{connectionError || agentError || '连接状态暂时无法读取，请打开客户端检查。'}</p>}
      </section>

      {/* 2. KPI 英雄排 */}
      <div className="mc-hero mc-stagger">
        <Kpi label="运行中" value={o ? <NumberTicker value={o.runningNow} /> : '—'} pulse={!!o?.runningNow} tone={o?.runningNow ? 'cyan' : 'idle'} note={!o ? '等待运行统计' : o.runningNow ? '队列正在执行' : '队列空闲'} />
        <Kpi
          label="今日运行"
          value={<CountUp value={o?.runsToday ?? null} />}
          tone="idle"
          note={`近 ${days} 天共 ${formatCount(windowRuns ?? null)} 次`}
          visual={<Sparkline values={(o?.perDay ?? []).map((d) => d.count)} color={MC.cyan} />}
          to="/runs"
        />
        <Kpi
          label={`成功率 · ${days} 天`}
          value={o?.successRate != null ? <NumberTicker value={o.successRate * 100} decimalPlaces={1} suffix="%" /> : '—'}
          tone={successTone}
          note={o?.successRate == null ? "暂无可统计运行" : successTone === "ok" ? "达标" : `低于 ${SUCCESS_TARGET * 100}% 阈值`}
          visual={<Ring ratio={o?.successRate ?? null} color={getTone(successTone, { MC, OUTCOME })} />}
        />
        <Kpi
          label="未处理事件"
          value={<CountUp value={events.data ? unacked : null} />}
          tone={unacked ? "bad" : "idle"}
          alarm={unacked > 0}
          note={!events.data ? '等待事件统计' : captcha ? `验证码 ${captcha} 次` : '没有待处理'}
          to="/browser-events"
        />
        <Kpi
          label="LLM 消耗"
          value={formatCount(llm.data?.totalTokens ?? null)}
          tone="idle"
          note={`P95 ${formatDuration(llm.data?.p95LatencyMs)} · ${formatCount(llm.data?.total)} 次`}
          to="/llm"
        />
      </div>

      {/* 3-6. 主网格 */}
      <div className="mc-grid mc-stagger">
        <MagicCard className="mc-glass mc-card mc-c7">
          <CardHead title={`近 ${days} 天运行`} linkTo="/runs" linkText="全部运行 →" />
          {overview.isError ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : <TrendChart data={o?.perDay ?? []} height={296} />}
          <BorderBeam />
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c5">
          <CardHead title="事件构成" linkTo="/browser-events" linkText="事件中心 →" />
          {events.isError ? <ErrorState error={events.error} onRetry={() => events.refetch()} /> : events.isLoading ? (
            <div className="mc-empty">加载中…</div>
          ) : (
            <EventChart byKind={events.data?.byKind ?? []} height={296} />
          )}
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c4">
          <CardHead title={`Book 健康度 · ${days} 天`} linkTo="/books" linkText="全部 →" />
          {overview.isError ? <ErrorState error={overview.error} /> : <HealthList rows={bookHealth} hrefBase="/books" loading={overview.isLoading} />}
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c4">
          <CardHead title="流程健康度" linkTo="/flows" linkText="全部 →" />
          {flows.isError ? <ErrorState error={flows.error} onRetry={() => flows.refetch()} /> : <HealthList rows={flowHealth} hrefBase="/flows" loading={flows.isLoading} />}
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c4">
          <CardHead title={`LLM 渠道 · ${days} 天`} linkTo="/llm" linkText="渠道管理 →" />
          {llm.isError ? <ErrorState error={llm.error} onRetry={() => llm.refetch()} /> : <HealthList rows={channelHealth} loading={llm.isLoading} emptyText="该范围内没有调用" />}
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c5">
          <CardHead title="最近失败" linkTo="/runs" linkText="全部 →" />
          {overview.isError ? <ErrorState error={overview.error} /> : overview.isLoading ? (
            <div className="mc-empty">加载中…</div>
          ) : (o?.recentFailures ?? []).length === 0 ? (
            <div className="mc-empty">该范围内没有失败 ✓</div>
          ) : (
            <div className="mc-feed">
              {(o?.recentFailures ?? []).slice(0, 4).map((r) => (
                <div key={r.id} className="mc-feed-item">
                  <StatusDot status={r.status} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <Link to={`/runs/${r.id}`} style={{ fontWeight: 500 }}>{r.book?.name ?? "—"}</Link>
                      <span className="mc-feed-time">{dayjs(r.queuedAt).format("MM-DD HH:mm")}</span>
                    </div>
                    <div className="mc-feed-err">{r.errorMessage ?? "—"}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c4">
          <CardHead title="即将触发" linkTo="/schedules" linkText="定时任务 →" />
          {schedules.isError ? <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} /> : schedules.isLoading ? (
            <div className="mc-empty">加载中…</div>
          ) : upcoming.length === 0 ? (
            <div className="mc-empty">没有启用中的定时任务</div>
          ) : (
            <div className="mc-timeline">
              {upcoming.map((u) => (
                <div key={`${u.id}-${u.at}`} className="mc-timeline-row">
                  <span className="mc-timeline-name">{u.name}</span>
                  <span className="mc-timeline-eta">{u.when}</span>
                </div>
              ))}
            </div>
          )}
        </MagicCard>

        <MagicCard className="mc-glass mc-card mc-c3">
          <CardHead title="实时运行流" linkTo="/runs" linkText="→" />
          {overview.isError ? <ErrorState error={overview.error} /> : overview.isLoading ? (
            <div className="mc-empty">加载中…</div>
          ) : (
            <div className="mc-feed">
              {(o?.recent ?? []).slice(0, 7).map((r) => (
                <div key={r.id} className="mc-feed-item" style={{ padding: "6px 2px" }}>
                  <StatusDot status={r.status} />
                  <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <Link to={`/runs/${r.id}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.book?.name ?? "—"}
                    </Link>
                    <span className="mc-feed-time">{relTime(r.queuedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </MagicCard>
      </div>
    </div>
  );
}

/* ─────────────────────────── 数据小件 ─────────────────────────── */

/** 数字滚动。值变化时从旧值缓动到新值——仪表盘的数是活的，不该跳变。 */
function CountUp({ value }: { value: number | null }) {
  if (value == null) return <>—</>;
  return <NumberTicker value={value} />;
}

type Tone = "ok" | "warn" | "bad" | "idle" | "cyan";

function getTone(tone: Tone, mc: { MC: { warn: string; ink3: string; cyan: string; ink1: string }; OUTCOME: { success: { color: string }; failed: { color: string } } }): string {
  switch (tone) {
    case "ok": return mc.OUTCOME.success.color;
    case "warn": return mc.MC.warn;
    case "bad": return mc.OUTCOME.failed.color;
    case "idle": return mc.MC.ink3;
    case "cyan": return mc.MC.cyan;
  }
}

function Chip({
  ok,
  label,
  detail,
  dotColor,
  neutral,
}: {
  ok?: boolean;
  label: string;
  detail?: string;
  dotColor?: string;
  /** neutral：这个 chip 的颜色只表类别（如已中止紫），不表健康。 */
  neutral?: boolean;
}) {
  const { mode: _mode } = useTheme();
  const { MC, OUTCOME } = buildMC(getPalette(_mode));
  const color = dotColor ?? (ok == null ? MC.ink3 : ok ? OUTCOME.success.color : OUTCOME.failed.color);
  return (
    <span className="mc-chip">
      <span className={`mc-dot${ok !== false && !neutral ? " live" : ""}`} style={{ background: color, color }} />
      {label}
      <b>{detail ?? (ok == null ? "未知" : ok ? "正常" : "异常")}</b>
    </span>
  );
}

function Kpi({
  label,
  value,
  tone,
  note,
  visual,
  to,
  pulse,
  alarm,
}: {
  label: ReactNode;
  value: ReactNode;
  tone: Tone;
  note?: ReactNode;
  visual?: ReactNode;
  to?: string;
  pulse?: boolean;
  alarm?: boolean;
}) {
  const { mode: _mode } = useTheme();
  const { MC, OUTCOME } = buildMC(getPalette(_mode));
  const body = (
    <MagicCard className={`mc-glass mc-kpi${alarm ? ' alarm' : ''}`}>
      <span className="mc-kpi-label">
        {pulse && <span className="mc-dot live" style={{ background: MC.cyan, color: MC.cyan }} />}
        {label}
      </span>
      <div className="mc-kpi-row">
        <span className="mc-kpi-value" style={{ color: tone === "idle" ? MC.ink1 : getTone(tone, { MC, OUTCOME }) }}>
          {value}
        </span>
        {visual}
      </div>
      {note && <div className="mc-kpi-note">{note}</div>}
    </MagicCard>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function CardHead({ title, linkTo, linkText }: { title: string; linkTo?: string; linkText?: string }) {
  return (
    <div className="mc-card-head">
      <span className="mc-card-title">{title}</span>
      {linkTo && <Link className="mc-card-link" to={linkTo}>{linkText ?? "全部 →"}</Link>}
    </div>
  );
}

function relTime(iso: string): string {
  const m = dayjs().diff(dayjs(iso), "minute");
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function relativeFire(now: dayjs.Dayjs, at: string): string {
  const minutes = dayjs(at).diff(now, "minute");
  if (minutes < 1) return "即将";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function StatusDot({ status }: { status: string }) {
  const { mode: _mode } = useTheme();
  const { MC, OUTCOME } = buildMC(getPalette(_mode));
  const color =
    status === "success" ? OUTCOME.success.color
    : status === "failed" ? OUTCOME.failed.color
    : status === "escalated" ? OUTCOME.escalated.color
    : MC.cyan;
  return <span className="mc-dot" style={{ background: color, marginTop: 5 }} />;
}

/** 比例读弧长比读数字快。 */
function Ring({ ratio, color }: { ratio: number | null; color: string }) {
  const SIZE = 50, R = 20, C = 2 * Math.PI * R;
  const pct = ratio == null ? 0 : Math.max(0, Math.min(1, ratio));
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" style={{ display: "block" }}>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={6} />
      <circle
        cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={color} strokeWidth={6}
        strokeDasharray={`${C * pct} ${C}`} strokeLinecap="round"
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        style={{ filter: `drop-shadow(0 0 5px ${color})`, transition: "stroke-dasharray .6s ease" }}
      />
    </svg>
  );
}

/** 一个 KPI 光有当下的值说明不了它在变好还是变坏。 */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 88, H = 30, PAD = 2;
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = (W - PAD * 2) / (values.length - 1);
  const pt = (v: number, i: number) => [PAD + i * step, H - PAD - (v / max) * (H - PAD * 2)] as const;
  const line = values.map((v, i) => pt(v, i).join(",")).join(" ");
  const [lx, ly] = pt(values[values.length - 1], values.length - 1);
  return (
    <svg width={W} height={H} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      <polygon points={`${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`} fill={color} opacity={0.12} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.75} fill={color} />
    </svg>
  );
}

type HealthRow = { id: string; name: string; runs: number; bad: number; rate: number | null };

/**
 * 三张健康度榜共用一个形状，所以能横着比。
 * 一律按失败数排：跑得多且全绿的那个恰恰不需要你看。
 */
function HealthList({
  rows,
  hrefBase,
  loading,
  emptyText,
}: {
  rows: HealthRow[];
  hrefBase?: string;
  loading?: boolean;
  emptyText?: string;
}) {
  const { mode: _mode } = useTheme();
  const { MC, OUTCOME } = buildMC(getPalette(_mode));
  if (loading) return <div className="mc-empty">加载中…</div>;
  if (rows.length === 0) return <div className="mc-empty">{emptyText ?? "该范围内没有运行"}</div>;
  return (
    <div className="mc-health">
      {rows.map((r) => {
        const okPct = (r.rate ?? 0) * 100;
        const badPct = r.runs > 0 ? (r.bad / r.runs) * 100 : 0;
        const inner = (
          <>
            <span className="mc-health-name" title={r.name}>{r.name}</span>
            <span className="mc-health-track">
              <span className="ok-seg" style={{ width: `${okPct}%` }} />
              <span className="bad-seg" style={{ width: `${badPct}%` }} />
              <span className="rest-seg" style={{ width: `${Math.max(0, 100 - okPct - badPct)}%` }} />
            </span>
            <span className="mc-health-nums">
              <b style={{ color: r.bad > 0 ? OUTCOME.failed.color : MC.ink3 }}>{r.bad}</b>/{r.runs}
            </span>
            <span
              className="mc-health-rate"
              style={{
                color:
                  r.rate == null ? MC.ink3
                  : r.rate >= SUCCESS_TARGET ? OUTCOME.success.color
                  : r.rate >= 0.5 ? MC.warn
                  : OUTCOME.failed.color,
              }}
            >
              {r.rate == null ? "—" : `${Math.round(okPct)}%`}
            </span>
          </>
        );
        return hrefBase ? (
          <Link key={r.id} to={`${hrefBase}/${r.id}`} className="mc-health-row">{inner}</Link>
        ) : (
          <div key={r.id} className="mc-health-row">{inner}</div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── 图表 ─────────────────────────── */

/**
 * 近 N 天运行：单轴堆叠柱。
 * 只有一根 y 轴——双轴是图表里的头号错误。柱体带垂直渐变 + 微辉光，
 * showBackground 铺出「每日容量槽」的底，30 天时也不散。
 */
function TrendChart({ data, height = 240 }: { data: Array<{ date: string; count: number; success: number; failed: number }>; height?: number }) {
  const { mode: _mode } = useTheme();
  const { MC, AXIS: MC_AXIS, TOOLTIP: MC_TOOLTIP, OUTCOME } = buildMC(getPalette(_mode));
  const option = useMemo<EChartsOption>(() => {
    const vGrad = (c: string, glow: string) => ({
      type: "linear" as const, x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [
        { offset: 0, color: c },
        { offset: 1, color: glow },
      ],
    });
    const bar = (key: keyof typeof OUTCOME, values: number[], top: string, bottom: string) => ({
      name: OUTCOME[key].label,
      type: "bar" as const,
      stack: "total",
      barMaxWidth: 34,
      itemStyle: {
        color: vGrad(top, bottom),
        borderColor: "rgba(7,11,22,0.9)",
        borderWidth: 2,
        borderRadius: key === "success" ? [4, 4, 0, 0] : 0,
      },
      emphasis: { focus: "series" as const },
      data: values,
    });
    return {
      textStyle: { color: MC.ink2 },
      tooltip: MC_TOOLTIP,
      legend: { ...MC_LEGEND, data: [OUTCOME.success.label, OUTCOME.other.label, OUTCOME.failed.label] },
      grid: { top: 34, right: 8, bottom: 24, left: 40 },
      xAxis: { ...MC_AXIS.category, data: data.map((d) => d.date.slice(5)) },
      yAxis: { ...MC_AXIS.value },
      series: [
        {
          ...bar("success", data.map((d) => d.success), "#34D399", "rgba(52,211,153,0.25)"),
          showBackground: true,
          backgroundStyle: { color: "rgba(255,255,255,0.03)", borderRadius: [4, 4, 0, 0] },
        },
        bar("other", data.map((d) => Math.max(0, d.count - d.success - d.failed)), "rgba(232,237,247,0.35)", "rgba(232,237,247,0.10)"),
        bar("failed", data.map((d) => d.failed), "#F87171", "rgba(248,113,113,0.22)"),
      ],
    };
  }, [data]);
  return <Chart option={option} height={height} />;
}

/**
 * 事件构成：横向条。
 * 验证码是唯一真要人动手的一类，给它琥珀色 + 辉光；其余中性。
 */
function EventChart({ byKind, height }: { byKind: Array<{ kind: string; count: number }>; height?: number }) {
  const { mode: _mode } = useTheme();
  const { MC, AXIS: MC_AXIS, TOOLTIP: MC_TOOLTIP } = buildMC(getPalette(_mode));
  const option = useMemo<EChartsOption>(() => {
    const rows = [...byKind].sort((a, b) => a.count - b.count);
    return {
      textStyle: { color: MC.ink2 },
      tooltip: MC_TOOLTIP,
      legend: { show: false },
      grid: { top: 8, right: 40, bottom: 8, left: 88 },
      xAxis: { ...MC_AXIS.value, splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)", type: "dashed" as const } } },
      yAxis: { ...MC_AXIS.category, data: rows.map((r) => EVENT_LABEL[r.kind] ?? r.kind) },
      series: [
        {
          type: "bar",
          barMaxWidth: 16,
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: (p: { name: string }) =>
              p.name === EVENT_LABEL.captcha_appeared
                ? {
                    type: "linear" as const, x: 0, y: 0, x2: 1, y2: 0,
                    colorStops: [
                      { offset: 0, color: "rgba(251,191,36,0.35)" },
                      { offset: 1, color: "#FBBF24" },
                    ],
                  }
                : {
                    type: "linear" as const, x: 0, y: 0, x2: 1, y2: 0,
                    colorStops: [
                      { offset: 0, color: "rgba(34,211,238,0.20)" },
                      { offset: 1, color: "rgba(34,211,238,0.75)" },
                    ],
                  },
          },
          label: { show: true, position: "right", color: MC.ink2, fontSize: 11 },
          data: rows.map((r) => r.count),
        },
      ],
    };
  }, [byKind]);
  return <Chart option={option} height={height ?? Math.max(150, byKind.length * 38 + 30)} />;
}
