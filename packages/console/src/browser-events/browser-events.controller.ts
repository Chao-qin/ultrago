import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { BrowserEventIngestInput, BrowserEventListQuery } from "@bcp/shared";
import { BrowserEventsService } from "./browser-events.service.js";

/**
 * 摄入口：backend 的 `BCP_EVENT_WEBHOOK` 打这里。
 *
 * 放在 `internal/` 而不是 `api/`，与 `internal/deliveries/ingest` 同一理由——
 * 这是**机器对机器**的边界，不是给界面用的 API，也不该被 SPA fallback 接管。
 *
 * `@HttpCode(200)` 是**契约的一部分，不是风格**：推送端只认 `res.ok`，非 2xx
 * 就打一行 warn 把事件丢掉，不重试。所以这里既不能 201 也不能 204——201 其实
 * 也算 ok，但 200 是 delivery-ingest 已经立下的形状，两个摄入口没有理由不一样。
 */
@Controller("internal/browser-events")
export class BrowserEventIngestController {
  constructor(@Inject(BrowserEventsService) private readonly events: BrowserEventsService) {}

  @Post("hook")
  @HttpCode(200)
  hook(@Body() body: BrowserEventIngestInput) {
    return this.events.ingest(body ?? {});
  }
}

/** 管理面：浏览器事件的 CRUD，「事件通知」页面在用。 */
@Controller("api/browser-events")
export class BrowserEventsController {
  constructor(@Inject(BrowserEventsService) private readonly events: BrowserEventsService) {}

  @Get()
  list(@Query() query: Record<string, string | undefined>) {
    return this.events.list(parseQuery(query));
  }

  /** 计数单独一个端点，不塞进 list 的响应里：列表每翻一页都要重查，而计数
   *  只随筛选条件变。合在一起等于每翻页多跑三个 count。 */
  @Get("stats")
  stats(@Query() query: Record<string, string | undefined>) {
    return this.events.stats(parseQuery(query));
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.events.findById(id);
  }

  @Post(":id/acknowledge")
  acknowledge(@Param("id") id: string, @Body() body: { acknowledged?: boolean } = {}) {
    // 不传 = 标记已处理。取消处理要显式传 false，这样「点一下确认」是默认动作。
    return this.events.setAcknowledged(id, body?.acknowledged !== false);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string) {
    return this.events.restore(id);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.events.remove(id);
  }
}

/**
 * query string → 类型化的过滤条件。
 *
 * 全仓没装 `class-validator`（main.ts 写明这是个刻意的决定），所以转换手写在这里。
 * 关键是 `unacknowledged` 的三态：**缺席**（两种都要）必须区别于 **false**
 * （只要已处理的）。写成 `q.unacknowledged === "true"` 会把缺席悄悄折叠成 false，
 * 于是默认列表只剩已处理的事件——一个不报错、只是内容不对的 bug。
 */
export function parseQuery(q: Record<string, string | undefined>): BrowserEventListQuery {
  return {
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.browser ? { browser: q.browser } : {}),
    ...(q.search ? { search: q.search } : {}),
    ...(q.unacknowledged !== undefined ? { unacknowledged: q.unacknowledged === "true" } : {}),
    includeDeleted: q.includeDeleted === "true",
    ...(q.page ? { page: Number(q.page) } : {}),
    ...(q.pageSize ? { pageSize: Number(q.pageSize) } : {}),
  };
}
