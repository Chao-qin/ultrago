import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import type { LlmCallIngestInput, LlmCallListQuery, LlmChannelDraft, LlmKeySettings } from "@bcp/shared";
import { LlmCallsService } from "./llm-calls.service.js";
import { LlmGatewayClient } from "./llm-gateway.client.js";

/**
 * 摄入口：@bcp/llm 网关每服务一次请求就打这里。
 *
 * 放在 `internal/` 而不是 `api/`，与 `internal/browser-events/hook` 和
 * `internal/deliveries/ingest` 同一理由——机器对机器的边界，不该被 SPA
 * fallback 接管。
 *
 * `@HttpCode(200)` 同样是**契约的一部分**：推送端只认 `res.ok`，非 2xx 就丢掉
 * 不重试。这里比事件通道更不该挑剔——丢一行日志只是少一行，让网关等我们才是事故。
 */
@Controller("internal/llm-calls")
export class LlmCallIngestController {
  constructor(@Inject(LlmCallsService) private readonly calls: LlmCallsService) {}

  @Post("hook")
  @HttpCode(200)
  hook(@Body() body: LlmCallIngestInput) {
    return this.calls.ingest(body ?? {});
  }
}

/** 管理面：调用日志的读取与软删，「LLM」页面在用。 */
@Controller("api/llm-calls")
export class LlmCallsController {
  constructor(@Inject(LlmCallsService) private readonly calls: LlmCallsService) {}

  @Get()
  list(@Query() query: Record<string, string | undefined>) {
    return this.calls.list(parseQuery(query));
  }

  /** 计数单独一个端点，理由同 browser-events：列表每翻一页都要重查，而聚合
   *  只随筛选条件变；合在一起等于每翻页多跑几个 count。 */
  @Get("stats")
  stats(@Query() query: Record<string, string | undefined>) {
    return this.calls.stats(parseQuery(query));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.calls.findById(id);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.calls.remove(id);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string) {
    return this.calls.restore(id);
  }
}

/** 渠道视图：现问网关，不落库。配置的真相源在 packages/llm/channels.json。 */
@Controller("api/llm")
export class LlmChannelsController {
  constructor(@Inject(LlmGatewayClient) private readonly gateway: LlmGatewayClient) {}

  @Get("channels")
  channels() {
    return this.gateway.channels();
  }

  /** 管理面直接代理给网关：配置的真相源是 packages/llm/channels.json，
   *  console 不复制它，也就不会有两份互相打架的配置。 */
  @Get("admin")
  admin() {
    return this.gateway.admin();
  }

  @Put("admin/channels")
  save(@Body() body: { channels?: LlmChannelDraft[] }) {
    return this.gateway.saveChannels(body?.channels ?? []);
  }

  @Post("admin/channels/:id/test")
  @HttpCode(200)
  test(@Param("id") id: string) {
    return this.gateway.testChannel(id);
  }

  /** POST 是为了带一份渠道声明，不是因为它会改什么——所以钉 200，见网关 probeUpstreamModels。 */
  @Post("admin/models")
  @HttpCode(200)
  models(@Body() body: { channel?: LlmChannelDraft }) {
    return this.gateway.upstreamModels(body?.channel);
  }

  /** 用途别名。保存失败时网关的原文就是最终答案（指向不存在的模型会拒绝切换）。 */
  @Put("admin/aliases")
  saveAliases(@Body() body: { aliases?: Record<string, string[]> }) {
    return this.gateway.saveAliases(body?.aliases ?? {});
  }

  @Put("admin/limits")
  saveLimits(@Body() body: { limits?: { maxConcurrency?: number } }) {
    return this.gateway.saveLimits(body?.limits ?? {});
  }

  /** 网关自身的运行时快照：闸上多少在飞 / 排队、哪条渠道正被降级。不打上游。 */
  @Get("admin/runtime")
  runtime() {
    return this.gateway.runtime();
  }

  @Get("admin/keys")
  keys() {
    return this.gateway.keys();
  }

  /**
   * 签发一把 key。
   *
   * 响应里带着**明文，而且仅此一次** —— 网关只存哈希，之后任何接口都再取不到。
   * 界面必须当场让用户复制走。
   */
  @Post("admin/keys")
  @HttpCode(200)
  createKey(@Body() body: { name?: string; settings?: LlmKeySettings }) {
    return this.gateway.createKey(body?.name ?? "", body?.settings ?? {});
  }

  /** 改一把已签发 key 的配置。改不了 hash/prefix —— 那是它的身份不是它的设置。 */
  @Put("admin/keys/:id")
  updateKey(@Param("id") id: string, @Body() body: { settings?: LlmKeySettings }) {
    return this.gateway.updateKey(id, body?.settings ?? {});
  }

  /** 明文按需取。**单独一个端点**，不混进 key 列表 —— 见 LlmApiKeyView.revealable。 */
  @Get("admin/keys/:id/secret")
  revealKey(@Param("id") id: string) {
    return this.gateway.revealKey(id);
  }

  /** 用这把 key 真打一次网关自己，把鉴权/限流/白名单/路由整条链路都测到。 */
  @Post("admin/keys/:id/test")
  @HttpCode(200)
  testKey(@Param("id") id: string) {
    return this.gateway.testKey(id);
  }

  @Post("admin/keys/:id/revoke")
  @HttpCode(200)
  revokeKey(@Param("id") id: string) {
    return this.gateway.keyAction(id, "revoke");
  }

  @Post("admin/keys/:id/restore")
  @HttpCode(200)
  restoreKey(@Param("id") id: string) {
    return this.gateway.keyAction(id, "restore");
  }

  @Delete("admin/keys/:id")
  deleteKey(@Param("id") id: string) {
    return this.gateway.deleteKey(id);
  }

  /** 本机免 key 的开关。**这一个开关就是「对内 → 对外」的全部切换。** */
  @Put("admin/keys/settings")
  keySettings(@Body() body: { allowLoopback?: boolean }) {
    return this.gateway.saveKeySettings(body?.allowLoopback !== false);
  }
}

/** query string 全是字符串，这里是唯一一处把它变回类型的地方。
 *
 *  `includeDeleted` 用 `=== "true"` 而不是真值判断：`?includeDeleted=false`
 *  必须是 false，而 `"false"` 是个真值字符串。 */
function parseQuery(query: Record<string, string | undefined>): LlmCallListQuery {
  return {
    since: query.since || undefined,
    channel: query.channel || undefined,
    adapter: query.adapter || undefined,
    model: query.model || undefined,
    caller: query.caller || undefined,
    status: query.status || undefined,
    search: query.search || undefined,
    includeDeleted: query.includeDeleted === "true",
    page: query.page ? Number(query.page) : undefined,
    pageSize: query.pageSize ? Number(query.pageSize) : undefined,
  };
}
