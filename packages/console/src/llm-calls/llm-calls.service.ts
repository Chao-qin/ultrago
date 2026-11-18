import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { LlmCall } from "@prisma/client";
import type {
  LlmCallIngestInput,
  LlmCallListQuery,
  LlmCallStats,
  Paginated,
} from "@bcp/shared";
import { PrismaService } from "../prisma/prisma.service.js";

/** Calls accumulate unattended, so paginate from the start, not after it hurts. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Previews are for "what did it actually say", not for storage. The gateway
 *  already truncates; this is the backstop for a sender that forgot to. */
const MAX_PREVIEW_CHARS = 4000;

/**
 * 调用日志保留多少天。`0` 关掉清理。
 *
 * 这张表没有任何自然上界：网关每服务一次请求就往里推一条，而一次商品预处理
 * 就是几十上百次调用。默认 30 天，因为它要回答的问题（哪条流程在超时/烧钱、
 * 上周花了多少）都落在一个月内；再往前的行只是在让 SQLite 变大。
 */
const RETENTION_DAYS = Number(process.env.BCP_LLM_CALL_RETENTION_DAYS ?? "30");

/**
 * 网关调用日志的落库与检索。
 *
 * **摄入侧沿用 browser-events 那条纪律：能存下来就别拒绝。** 推送端同样是
 * 一次投递、无队列、无重试，所以这个接口每返回一次非 2xx 就是一条日志被永久
 * 丢弃。而且这里的赌注更歪：日志丢了只是少一行，**拖慢或搞挂网关才是事故**。
 *
 * 有一处我们比 browser-events 更松：**`channel` 也不是必需的**。
 * browser-events 要求 `kind`，理由是"没有它就不是事件"；照搬到这里会变成
 * 「路由失败的请求记不下来」——而「有人把 model 写错了、网关回了 404」恰恰是
 * 最该被看见的一类。那一刻**根本还没有 channel**。所以缺失时落成 `(unrouted)`，
 * 而不是把它拒之门外。
 */
@Injectable()
export class LlmCallsService {
  private readonly logger = new Logger(LlmCallsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 落一条网关推过来的调用。没有幂等键，理由同 browser-events：推送端只发一次。 */
  async ingest(input: LlmCallIngestInput): Promise<LlmCall> {
    const num = (v: unknown): number | null => (Number.isFinite(v) ? Number(v) : null);
    return this.prisma.llmCall.create({
      data: {
        channel: (input?.channel ?? "").trim() || "(unrouted)",
        adapter: (input?.adapter ?? "").trim() || "(none)",
        model: (input?.model ?? "").trim() || "(unknown)",
        stream: input?.stream === true,
        // 只认 "error"，其余一律 ok：一个拼错的 status 不值得丢掉整条记录。
        status: input?.status === "error" ? "error" : "ok",
        httpStatus: num(input?.httpStatus),
        errorKind: (input?.errorKind ?? "").trim() || null,
        errorMessage: clip(input?.errorMessage),
        latencyMs: num(input?.latencyMs),
        ttfbMs: num(input?.ttfbMs),
        promptTokens: num(input?.promptTokens),
        completionTokens: num(input?.completionTokens),
        totalTokens: num(input?.totalTokens),
        requestPreview: clip(input?.requestPreview),
        responsePreview: clip(input?.responsePreview),
        // 空串归一成 null：「没报调用方」和「报了个空的」在界面上该是同一件事。
        caller: (input?.caller ?? "").trim() || null,
        // num() 已经把非数字变成 null —— 成本与 token 同一条纪律：**缺失保持
        // 缺失**。0 会让「免费」和「算不出来」在任何汇总里变成同一件事。
        costMicros: num(input?.costMicros),
        costCurrency: (input?.costCurrency ?? "").trim() || null,
        attempt: num(input?.attempt),
        // 网关时钟缺失时用本机兜底。两个时钟对不上好过一条 1970 年的记录。
        startedAt: new Date(Number.isFinite(input?.startedAt) ? Number(input?.startedAt) : Date.now()),
      },
    });
  }

  async list(query: LlmCallListQuery = {}): Promise<Paginated<LlmCall>> {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(query.pageSize) || DEFAULT_PAGE_SIZE)),
    );
    const where = this.buildWhere(query);
    // count + findMany：SQLite 没有 window function 版本的总数，而分页控件
    // 要真实 total 才画得出页码。
    const [total, items] = await Promise.all([
      this.prisma.llmCall.count({ where }),
      this.prisma.llmCall.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total };
  }

  /** 单条详情。软删的行照样能取到——列表藏起它们，但拿着 id 直接问「这条是什么」
   *  时，一个墓碑标记不构成拒绝回答的理由。 */
  async findById(id: string): Promise<LlmCall> {
    const row = await this.prisma.llmCall.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`llm call ${id} not found`);
    return row;
  }

  /** 软删。已经删过的再删一次是 no-op，不报错。 */
  async remove(id: string): Promise<LlmCall> {
    const row = await this.findById(id);
    if (row.deletedAt) return row;
    return this.prisma.llmCall.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async restore(id: string): Promise<LlmCall> {
    await this.findById(id);
    return this.prisma.llmCall.update({ where: { id }, data: { deletedAt: null } });
  }

  /** 列表头上的聚合。与 list 用同一个 where —— 分开写就是让两个数字迟早对不上。 */
  async stats(query: LlmCallListQuery = {}): Promise<LlmCallStats> {
    const where = this.buildWhere(query);
    const [total, errors, tokens, byChannel, byChannelErrors, byCurrency, byCaller, byCallerErrors, p95] =
      await Promise.all([
        this.prisma.llmCall.count({ where }),
        this.prisma.llmCall.count({ where: { ...where, status: "error" } }),
        this.prisma.llmCall.aggregate({ where, _sum: { totalTokens: true } }),
        this.prisma.llmCall.groupBy({
          by: ["channel", "adapter"],
          where,
          _count: { _all: true },
          _sum: { totalTokens: true, costMicros: true },
        }),
        // 条件计数没法塞进同一个 groupBy，所以错误单独 group 一次再合。
        this.prisma.llmCall.groupBy({
          by: ["channel"],
          where: { ...where, status: "error" },
          _count: { _all: true },
        }),
        // 花费**按货币分组求和**，不合成一个数。两条渠道一条报 USD 一条报 CNY
        // 时，加起来得到的数看着完全正常却没有任何意义，而汇率不是这个系统该
        // 知道的东西。算不出成本的调用（没单价 / 上游没报 usage）被这个 where
        // 排除在外——它们是「未知」，不该被当成 0 拉低任何一格。
        this.prisma.llmCall.groupBy({
          by: ["costCurrency"],
          where: { ...where, costMicros: { not: null } },
          _count: { _all: true },
          _sum: { costMicros: true },
        }),
        this.prisma.llmCall.groupBy({
          by: ["caller"],
          where,
          _count: { _all: true },
          _sum: { totalTokens: true, costMicros: true },
        }),
        this.prisma.llmCall.groupBy({
          by: ["caller"],
          where: { ...where, status: "error" },
          _count: { _all: true },
        }),
        this.percentileLatency(where, 0.95),
      ]);

    const errorsByChannel = new Map(byChannelErrors.map((g) => [g.channel, g._count._all]));
    const errorsByCaller = new Map(byCallerErrors.map((g) => [g.caller ?? "", g._count._all]));
    return {
      total,
      errors,
      p95LatencyMs: p95,
      totalTokens: tokens._sum.totalTokens ?? 0,
      byChannel: byChannel
        .map((g) => ({
          channel: g.channel,
          adapter: g.adapter,
          count: g._count._all,
          errors: errorsByChannel.get(g.channel) ?? 0,
          // null 而不是 0：这一段里没有任何一次调用报过 usage，和「用了 0 个
          // token」是两件事。成本同理。
          totalTokens: g._sum.totalTokens ?? null,
          costMicros: g._sum.costMicros ?? null,
        }))
        .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel)),
      costByCurrency: byCurrency
        .map((g) => ({
          // 有成本却没报货币的（渠道单价没填 currency）归到一个显式的桶里，
          // 而不是悄悄并进某个真实货币。
          currency: g.costCurrency ?? "(未标货币)",
          costMicros: g._sum.costMicros ?? 0,
          count: g._count._all,
        }))
        .sort((a, b) => b.costMicros - a.costMicros),
      byCaller: byCaller
        .map((g) => ({
          // 没报调用方的落进一个显式的「未标注」，不要让它看起来像某条流程。
          caller: g.caller ?? "(未标注)",
          count: g._count._all,
          errors: errorsByCaller.get(g.caller ?? "") ?? 0,
          totalTokens: g._sum.totalTokens ?? null,
          costMicros: g._sum.costMicros ?? null,
        }))
        .sort((a, b) => b.count - a.count || a.caller.localeCompare(b.caller)),
    };
  }

  /**
   * 按保留期清掉老记录。
   *
   * **硬删，不软删。** 软删是给「我误删了想找回来」用的，而这里删的是没人再会
   * 看的历史——留着墓碑行只会让这张表继续长，一件事都没解决。
   *
   * 按 `startedAt` 而不是 `receivedAt`：问的是「这次调用什么时候发生的」。两个
   * 时钟能差很远，而按落库时间删会在网关离线补推日志时删错东西。
   */
  async purgeOlderThan(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.llmCall.deleteMany({
      where: { startedAt: { lt: cutoff } },
    });
    return count;
  }

  /**
   * 每天凌晨清一次。
   *
   * 挑一个没人看仪表盘的时刻，是因为 deleteMany 会持有写锁，而 SQLite 的写是
   * 全库串行的——白天跑等于让每一次 book 回放和日志摄入都排在它后面。
   *
   * 失败只记一条日志：清理是保养，不是功能，它失败不该把 console 拖垮，而下一
   * 次触发会连着上次没删掉的一起删。
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpired(): Promise<void> {
    if (!(RETENTION_DAYS > 0)) return;
    try {
      const removed = await this.purgeOlderThan(RETENTION_DAYS);
      if (removed > 0) {
        this.logger.log(`清理了 ${removed} 条超过 ${RETENTION_DAYS} 天的 LLM 调用日志`);
      }
    } catch (error) {
      this.logger.warn(
        `LLM 调用日志清理失败（下次触发会一起补上）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 精确分位数，不用均值。
   *
   * 一次 240s 超时就能把平均延迟拉成小说，而 p95 只会让它落在该落的地方。
   * SQLite 没有 percentile 函数，Prisma 也没有；这里用「先数个数、再 skip 到
   * 那一行」拿真值——两次查询，传输量 O(1)，不是把整列拉回内存算。
   */
  private async percentileLatency(
    where: ReturnType<LlmCallsService["buildWhere"]>,
    q: number,
  ): Promise<number | null> {
    const scoped = { ...where, latencyMs: { not: null } };
    const n = await this.prisma.llmCall.count({ where: scoped });
    if (n === 0) return null;
    const index = Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1));
    const [row] = await this.prisma.llmCall.findMany({
      where: scoped,
      orderBy: { latencyMs: "asc" },
      skip: index,
      take: 1,
      select: { latencyMs: true },
    });
    return row?.latencyMs ?? null;
  }

  /** list 与 stats 共用的过滤条件。 */
  private buildWhere(query: LlmCallListQuery = {}) {
    const search = (query.search ?? "").trim();
    // startedAt 而不是 receivedAt：问的是"这次调用什么时候发生的"，
    // 不是"日志什么时候落的库"。两个时钟能差很远。
    const since = query.since ? new Date(query.since) : null;
    return {
      ...(since && !Number.isNaN(since.getTime()) ? { startedAt: { gte: since } } : {}),
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.adapter ? { adapter: query.adapter } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.caller ? { caller: query.caller } : {}),
      ...(query.status ? { status: query.status } : {}),
      // 三处一起搜：你记得的往往是回答里的一句话，或者那条报错，而不是提示词。
      ...(search
        ? {
            OR: [
              { requestPreview: { contains: search } },
              { responsePreview: { contains: search } },
              { errorMessage: { contains: search } },
            ],
          }
        : {}),
    };
  }
}

/** 截断到可存的长度。空串归一成 null——"" 和"没有"在界面上该是同一件事。 */
function clip(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text;
}
