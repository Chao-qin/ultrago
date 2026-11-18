import { HttpException, Injectable, Logger } from "@nestjs/common";
import type {
  LlmAdminView,
  LlmChannelDraft,
  LlmChannelTestResult,
  LlmChannelView,
  LlmKeyCreated,
  LlmKeySecret,
  LlmKeySettings,
  LlmKeyTestResult,
  LlmKeysView,
  LlmRuntimeView,
  LlmUpstreamModels,
} from "@bcp/shared";

/**
 * 只读地问网关「你现在有哪些渠道、活不活」。
 *
 * 形状照抄 `BackendClient`（console → backend 的 `internal/*` 代理）——同一个
 * 立场：console 不复制别人的状态，要用的时候现问。渠道配置的真相源是
 * `packages/llm/channels.json`，归网关管；这里**不缓存**，缓存就意味着界面上
 * 那个绿点可能是十分钟前的。
 */
const DEFAULT_GATEWAY = "http://127.0.0.1:11435";

/** 网关挂了要立刻说"挂了"，不是让页面转圈。 */
const TIMEOUT_MS = 6_000;

type ModelsResponse = {
  data?: {
    id?: string;
    bcp?: { adapter?: string; model?: string; baseUrl?: string; capabilities?: string[] };
  }[];
};

type HealthResponse = {
  channels?: { id?: string; status?: string; detail?: string }[];
};

@Injectable()
export class LlmGatewayClient {
  private readonly logger = new Logger(LlmGatewayClient.name);
  private readonly baseUrl =
    process.env.BCP_LLM_URL || `http://127.0.0.1:${process.env.BCP_LLM_PORT || "11435"}` || DEFAULT_GATEWAY;

  /**
   * 渠道列表 + 每条的健康状态。
   *
   * 两个端点合成一个视图：`/v1/models` 给"有什么"（不打上游，永远秒回），
   * `/health` 给"活不活"（逐渠道真探活，可能慢）。**健康探测失败不影响列表**——
   * 网关活着但某个上游挂了，你仍然该看得见这条渠道存在。
   */
  async channels(): Promise<LlmChannelView[]> {
    const models = await this.get<ModelsResponse>("/v1/models");
    if (!models) return [];

    // health 单独 catch：它比 models 慢且更容易失败，不该拖垮整个列表。
    const health = await this.get<HealthResponse>("/health").catch(() => null);
    const byId = new Map(
      (health?.channels ?? []).map((c) => [c.id ?? "", { status: c.status, detail: c.detail }]),
    );

    return (models.data ?? []).map((m) => {
      const id = m.id ?? "";
      const h = byId.get(id);
      return {
        id,
        adapter: m.bcp?.adapter ?? "",
        model: m.bcp?.model ?? "",
        baseUrl: m.bcp?.baseUrl ?? null,
        // 探测没跑成就是 unknown，不是 ok —— 只有真问过才敢说活着。
        health: h?.status ?? "unknown",
        healthDetail: h?.detail ?? null,
        capabilities: m.bcp?.capabilities ?? [],
      };
    });
  }

  /** 管理面：原始声明 + 可选适配器。网关不在时给空表，界面自己显示"连不上"。 */
  async admin(): Promise<LlmAdminView> {
    const view = (await this.get<LlmAdminView>("/admin/channels")) ?? { channels: [], adapters: [] };
    // 界面要能回答「这条渠道怎么用」，那需要网关的地址——而只有这一层知道它。
    // 网关自己回不了：`--port` 与 BCP_LLM_URL 都在启动它的那一侧，它监听的是
    // 127.0.0.1，没有「对外该怎么称呼我」的概念。这里给的正是 console 实际打
    // 它用的那个地址，也就是同一台机器上其它客户端该用的那个。
    return { ...view, gatewayBaseUrl: this.baseUrl };
  }

  /**
   * 保存渠道表。
   *
   * 网关那边是「先校验 → 再落盘 → 再切换」，校验不过会回 4xx 且**什么都没改**。
   * 这里把那段错误原样抛给界面 —— 它比任何我们能编的话都准确（它会直接告诉你
   * 哪个键拼错了、该改成什么）。
   */
  async saveChannels(channels: LlmChannelDraft[]): Promise<LlmAdminView> {
    return this.send<LlmAdminView>("/admin/channels", "PUT", { channels });
  }

  testChannel(id: string): Promise<LlmChannelTestResult> {
    return this.send<LlmChannelTestResult>(`/admin/channels/${encodeURIComponent(id)}/test`, "POST");
  }

  /**
   * 问「这份声明打到的上游有哪些模型」。要的是**声明**不是 id：一条还没保存的
   * 草稿也该问得到，理由见网关的 `probeUpstreamModels`。
   *
   * 用 POST 是因为要带一份 body，不是因为它会改什么——所以失败时不抛：网关不在
   * 只意味着「问不到」，界面那一栏要显示这句话，而不是让整个抽屉炸掉。
   */
  async upstreamModels(channel: LlmChannelDraft | undefined): Promise<LlmUpstreamModels> {
    try {
      return await this.send<LlmUpstreamModels>("/admin/models", "POST", { channel });
    } catch (error) {
      return {
        supported: false,
        models: [],
        reason: error instanceof Error ? error.message : "连不上 LLM 网关",
      };
    }
  }

  saveAliases(aliases: Record<string, string[]>): Promise<LlmAdminView> {
    return this.send<LlmAdminView>("/admin/aliases", "PUT", { aliases });
  }

  saveLimits(limits: { maxConcurrency?: number }): Promise<LlmAdminView> {
    return this.send<LlmAdminView>("/admin/limits", "PUT", { limits });
  }

  /** 运行时快照。网关不在时给一份空的——这是个仪表，不该让整页炸掉。 */
  async runtime(): Promise<LlmRuntimeView> {
    return (
      (await this.get<LlmRuntimeView>("/admin/runtime")) ?? {
        concurrency: { limit: null, global: { active: 0, queued: 0 }, channels: {} },
        channelHealth: {},
      }
    );
  }

  /**
   * key 列表。网关不在时按「敞开、没有 key」显示，与它此刻的真实行为一致。
   *
   * 每一行都补齐缺省值再往上给。**升级期间「前端已新、网关还旧」是常态**（网关
   * 是独立进程，重新 build 不等于重启它），而一个少了字段的响应会让界面在
   * `allowedModels.length` 上炸掉整棵组件树——白屏，且看不出是版本不齐。归一化
   * 放在这一层，上面的类型契约就能保持干净。
   */
  async keys(): Promise<LlmKeysView> {
    // strict：读不到 key 列表时必须报错，不能显示成「还没有签发过 key」——
    // 那句话的含义是「这个网关不设防」，而事实可能正好相反。
    const raw = await this.get<LlmKeysView>("/admin/keys", { strict: true });
    if (!raw) return { allowLoopback: true, authRequired: false, keys: [] };
    return {
      allowLoopback: raw.allowLoopback !== false,
      authRequired: raw.authRequired === true,
      keys: (raw.keys ?? []).map((k) => ({
        ...k,
        expiresAt: k.expiresAt ?? null,
        expired: k.expired === true,
        rateLimitPerMinute: k.rateLimitPerMinute ?? null,
        allowedModels: k.allowedModels ?? [],
        maxConcurrency: k.maxConcurrency ?? null,
      })),
    };
  }

  /** 签发。**响应里的明文是这把 key 唯一一次露面**，界面必须当场让用户复制。 */
  createKey(name: string, settings: LlmKeySettings = {}): Promise<LlmKeyCreated> {
    return this.send<LlmKeyCreated>("/admin/keys", "POST", { name, settings });
  }

  updateKey(id: string, settings: LlmKeySettings): Promise<LlmKeysView> {
    return this.send<LlmKeysView>(`/admin/keys/${encodeURIComponent(id)}`, "PUT", { settings });
  }

  /** 明文按需取。strict：读不到就报错，不要给出一个看起来像"空 key"的答案。 */
  async revealKey(id: string): Promise<LlmKeySecret> {
    return (
      (await this.get<LlmKeySecret>(`/admin/keys/${encodeURIComponent(id)}/secret`, { strict: true })) ?? {
        secret: null,
        reason: "连不上 LLM 网关",
      }
    );
  }

  testKey(id: string): Promise<LlmKeyTestResult> {
    return this.send<LlmKeyTestResult>(`/admin/keys/${encodeURIComponent(id)}/test`, "POST");
  }

  keyAction(id: string, action: "revoke" | "restore"): Promise<LlmKeysView> {
    return this.send<LlmKeysView>(`/admin/keys/${encodeURIComponent(id)}/${action}`, "POST");
  }

  deleteKey(id: string): Promise<LlmKeysView> {
    return this.send<LlmKeysView>(`/admin/keys/${encodeURIComponent(id)}`, "DELETE");
  }

  saveKeySettings(allowLoopback: boolean): Promise<LlmKeysView> {
    return this.send<LlmKeysView>("/admin/keys/settings", "PUT", { allowLoopback });
  }

  /** 写操作与只读不同：失败必须抛，否则界面会把"没保存成功"显示成"保存成功"。 */
  private async send<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 6),
    });
    const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) {
      // 带着网关自己的状态码往上抛。原先这里抛的是普通 Error，Nest 的兜底过滤器
      // 一律按 500 处理——于是网关明明回了一个说清楚原因的 4xx（哪条渠道缺
      // baseUrl、哪个键不认、哪个 id 重了），到界面上变成一个没头没尾的
      // 「500」。保存渠道时这一点尤其致命：那个抽屉里本来就有一块专门显示
      // 「网关拒绝了这份配置」的 Alert，它需要的正是这条原文。
      throw new HttpException(
        payload?.error?.message ?? `LLM 网关返回 HTTP ${res.status}`,
        res.status,
      );
    }
    return payload as T;
  }

  /**
   * 网关不在时返回 null 而不是抛：页面要能显示"网关没起来"，而不是白屏。
   *
   * `strict` 则相反：**网关答了、但答的是拒绝**时抛出去。这个区分有实际意义——
   * 「网关不在」可以安全地显示成空状态（没有网关就没有鉴权可言），而「网关在、
   * 但它拒绝我们」显示成空状态就是**撒谎**：界面会写着「未鉴权、还没有签发过
   * key」，而真相是已经签发了三把、并且我们被挡在门外。带安全含义的读取必须
   * 用 strict，宁可让页面显示一条报错。
   */
  private async get<T>(path: string, opts: { strict?: boolean } = {}): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // /health 在任一上游不可达时返回 503，但**响应体是有用的**（它列出了
      // 哪条渠道挂了），照样解析。其余非 2xx 一律当作「没有答案」。
      //
      // 这一条以前不存在，代价很具体：升级时网关还是旧进程、还没有
      // `/admin/runtime` 这个路由，它回的是 404 + `{error:{…}}`，而那个错误体
      // 被原样当成了 LlmRuntimeView —— 界面读 `concurrency.global` 时炸掉整棵
      // 组件树，白屏，且看不出跟版本有关。
      if (!res.ok && res.status !== 503) {
        this.logger.warn(`LLM 网关 ${this.baseUrl}${path} 回了 HTTP ${res.status}`);
        if (opts.strict) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new HttpException(
            body?.error?.message ?? `LLM 网关返回 HTTP ${res.status}`,
            res.status,
          );
        }
        return null;
      }
      return (await res.json()) as T;
    } catch (error) {
      this.logger.warn(
        `LLM 网关 ${this.baseUrl}${path} 不可达：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
