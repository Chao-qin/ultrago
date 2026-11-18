import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { BrowserEvent } from "@prisma/client";
import type {
  BrowserEventIngestInput,
  BrowserEventListQuery,
  BrowserEventStats,
  Paginated,
} from "@bcp/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordsService } from "../records/records.service.js";

/** Page size when the caller doesn't ask. Events accumulate unattended, so the
 *  list is paginated from the start rather than after it gets slow. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** `data:<mime>;base64,<payload>` — the only screenshot form the backend sends
 *  (`buildPayload` passes `captureVisibleTab`'s dataUrl straight through). */
const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w.+-]+)*;base64,(.+)$/s;

/** Strict base64 alphabet + padding.
 *
 *  Needed because `Buffer.from(s, "base64")` does NOT reject malformed input —
 *  it silently DROPS every character outside the alphabet and decodes whatever
 *  is left. `Buffer.from("@@@not-base64@@@", "base64")` yields 6 bytes, not an
 *  error, so a length check alone would happily write that garbage into
 *  resource/records/ under a `.png` name. A corrupt screenshot is worse than no
 *  screenshot: the row claims an image that renders as a broken icon, and the
 *  bytes on disk look like a real artifact to anyone auditing the directory. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 浏览器事件的落库与检索。
 *
 * **摄入侧的一条硬纪律：能存下来就别拒绝。**
 *
 * 推送端（backend 的 event-webhook.ts）是一次投递、无队列、无重试——它在文件头
 * 把这个选择写清楚了，理由是"撞上验证码"的价值只在当下。那条纪律的代价落在这边：
 * **这个接口每返回一次非 2xx，就是一条事件被永久丢弃**，对面只会打一行 warn
 * 然后继续。所以 `ingest` 的校验尺度和普通 CRUD 的 create 相反——普通 create
 * 拒绝脏数据是在保护数据；这里拒绝脏数据是在制造数据丢失。
 *
 * 具体做法：只有 `kind` 是必需的（它定义了这条记录**是什么**，没有它就不是事件），
 * 其余字段一律给默认值；截图解不开就丢图留事件，绝不因为一张坏图丢掉整条通知。
 */
@Injectable()
export class BrowserEventsService {
  private readonly logger = new Logger(BrowserEventsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RecordsService) private readonly records: RecordsService,
  ) {}

  /**
   * 落一条推送过来的事件。
   *
   * **没有幂等键，也不要加。** 看上去 `(browser, seq)` 是天然的唯一键，但
   * `seq` 是 backend EventStore 的**进程内**单调序号——backend 一重启就从头
   * 开始。给它加唯一索引的后果是：重启后的第一批事件撞上旧行的唯一键，
   * Prisma 抛 P2002，而这个接口的每一次抛错都等于一条事件永久消失。
   * 真正的重复投递在这条链路上也不存在：推送端只发一次。
   */
  async ingest(input: BrowserEventIngestInput): Promise<BrowserEvent> {
    const kind = (input?.kind ?? "").trim();
    if (!kind) throw new BadRequestException("event `kind` is required");

    const shot = this.storeScreenshot(input.screenshot, kind);

    return this.prisma.browserEvent.create({
      data: {
        kind,
        browser: input.browser ?? null,
        // -1 是推送端表示「与 tab 无关」的既定取值（browser_offline 就是它），
        // 所以缺失时用 -1 而不是 0：0 是一个真实存在过的 tabId。
        tabId: Number.isFinite(input.tabId) ? Number(input.tabId) : -1,
        // ts 缺失时用本机时间兜底。两个时钟对不上好过一条 1970 年的事件。
        occurredAt: new Date(Number.isFinite(input.ts) ? Number(input.ts) : Date.now()),
        seq: Number.isFinite(input.seq) ? Number(input.seq) : null,
        summary: (input.summary ?? "").trim() || `${kind} (无摘要)`,
        detail: input.detail ? JSON.stringify(input.detail) : null,
        screenshotName: shot?.fileName ?? null,
        screenshotUrl: shot?.url ?? null,
      },
    });
  }

  /**
   * data URL → resource/records/ 里的一个文件。
   *
   * 解不开就返回 null 并留一行日志，**不抛**：这个方法的调用方是 ingest，
   * 而 ingest 抛错就是丢事件。一条没有图的验证码通知仍然告诉了你"你被挡住了"，
   * 那是这条通道的全部价值所在；图只是附赠。
   */
  private storeScreenshot(dataUrl: string | undefined, kind: string): { fileName: string; url: string } | null {
    if (!dataUrl) return null;
    try {
      const m = DATA_URL_RE.exec(dataUrl);
      if (!m) throw new Error("not a base64 data URL");
      const mime = m[1] || "image/png";
      // Whitespace is legal filler in a data URL payload; strip it before the
      // alphabet check so a wrapped line doesn't read as corruption.
      const payload = m[2].replace(/\s+/g, "");
      if (!BASE64_RE.test(payload) || payload.length % 4 !== 0) {
        throw new Error("payload is not valid base64");
      }
      const bytes = Buffer.from(payload, "base64");
      if (!bytes.length) throw new Error("decoded to 0 bytes");
      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
      const saved = this.records.save(bytes, `${kind}.${ext}`, mime);
      return { fileName: saved.fileName, url: saved.url };
    } catch (e) {
      this.logger.warn(`screenshot dropped for ${kind}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** 分页列表。默认只看未删除的行；`includeDeleted` 明确要才带上软删行。 */
  async list(query: BrowserEventListQuery = {}): Promise<Paginated<BrowserEvent>> {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.pageSize) || DEFAULT_PAGE_SIZE)));
    const where = this.buildWhere(query);

    // 软删表态：`deletedAt` 的过滤在 buildWhere 里（默认 `deletedAt: null`，
    // includeDeleted 时整条约束不出现）。两个查询共用同一个 where 是刻意的——
    // total 与行必须来自同一套条件，否则「共 N 条」会把用户看不见的软删行也算进去。
    //
    // count + findMany 而不是一次查询：SQLite 没有 window function 版本的
    // 总数，而分页控件需要真实 total 才能画出页码。
    const [total, items] = await Promise.all([
      this.prisma.browserEvent.count({ where }),
      this.prisma.browserEvent.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total };
  }

  /** 单条详情。软删的行**照样能取到**——列表默认藏起它们，但拿着 id 直接问
   *  "这条是什么"时，一个墓碑标记不构成拒绝回答的理由（同 records.controller
   *  对 contentType 的立场）。行里带着 `deletedAt`，调用方自己看得见。 */
  async findById(id: string): Promise<BrowserEvent> {
    const row = await this.prisma.browserEvent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`browser event ${id} not found`);
    return row;
  }

  /** 标记「已处理 / 未处理」。本表唯一的更新操作。 */
  async setAcknowledged(id: string, acknowledged: boolean): Promise<BrowserEvent> {
    // findById 先跑：update 一个不存在的 id 会抛 P2025，那是 500 不是 404。
    await this.findById(id);
    return this.prisma.browserEvent.update({
      where: { id },
      data: { acknowledgedAt: acknowledged ? new Date() : null },
    });
  }

  /** 软删。已经删过的再删一次是 no-op，不报错——重复点删除不该是个错误。 */
  async remove(id: string): Promise<BrowserEvent> {
    const row = await this.findById(id);
    if (row.deletedAt) return row;
    return this.prisma.browserEvent.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** 撤销软删。本表没有任何唯一约束，所以恢复不会像 SchemaRecord 那样撞行。 */
  async restore(id: string): Promise<BrowserEvent> {
    await this.findById(id);
    return this.prisma.browserEvent.update({ where: { id }, data: { deletedAt: null } });
  }

  /** 真删，连同磁盘上的截图一起。**没有路由**——与 BooksService.purge 同一立场，
   *  界面上的「删除」是可逆的那个。留着它是为了将来真要回收空间时有个入口，
   *  以及给保留策略（本模块暂未实现）当落点。 */
  async purge(id: string): Promise<BrowserEvent> {
    // 软删与否都能 purge：purge 问的是「这行还要不要」，不是「它是不是活的」。
    const row = await this.findById(id);
    return this.prisma.browserEvent.delete({ where: { id: row.id } });
  }

  /** 列表头上的计数。与 list 用同一个 where，所以筛选一变计数跟着变。 */
  async stats(query: BrowserEventListQuery = {}): Promise<BrowserEventStats> {
    const where = this.buildWhere(query);
    const [total, unacknowledged, grouped] = await Promise.all([
      this.prisma.browserEvent.count({ where }),
      this.prisma.browserEvent.count({ where: { ...where, acknowledgedAt: null } }),
      this.prisma.browserEvent.groupBy({ by: ["kind"], where, _count: { _all: true } }),
    ]);
    return {
      total,
      unacknowledged,
      byKind: grouped
        .map((g) => ({ kind: g.kind, count: g._count._all }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    };
  }

  /** list 与 stats 共用的过滤条件——分开写就是让两个数字迟早对不上。 */
  private buildWhere(query: BrowserEventListQuery) {
    const search = (query.search ?? "").trim();
    return {
      // 软删表态：默认排除，includeDeleted 才放行。
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.browser ? { browser: query.browser } : {}),
      ...(query.unacknowledged === true ? { acknowledgedAt: null } : {}),
      ...(query.unacknowledged === false ? { acknowledgedAt: { not: null } } : {}),
      // summary 与 detail 一起搜：题面（"点击图中最小的红色球体"）落在 detail
      // 的 evidence 里，只搜 summary 会搜不到自己刚看过的那条。
      ...(search
        ? { OR: [{ summary: { contains: search } }, { detail: { contains: search } }] }
        : {}),
    };
  }
}
