/**
 * 网关的管理面（loopback，无鉴权——它和 /v1 同在 127.0.0.1）。
 *
 * 一条贯穿全部写操作的纪律：**配置写错绝不能搞挂正在服务的网关。**
 * 所以顺序永远是「先校验 → 再落盘 → 再切换」，三步任何一步失败都停在原地：
 * 旧渠道表继续服务，错误原样回给界面。这不是防御性编程，是因为另一种顺序
 * （先写再重载）会在重载失败时留下一个坏文件，下次启动直接起不来。
 *
 * 另一条：**这里读写的是「原始声明」，不是加载后的表。** `parseChannel` 会把
 * `env.NAME` 解引用成真密钥，加载后的表里躺着的是活的凭据；从它往回写就等于
 * 把密钥印进配置文件，从它往外读就等于把密钥吐给任何调这个接口的人。
 */
import type { Registry } from "./adapters/index.js";
import {
  isDirect,
  RequestError,
  type ChannelConfig,
  type JsonRecord,
} from "./adapters/types.js";
import {
  channelLabel,
  parseAliases,
  parseChannel,
  parseLimits,
  patchConfig,
  readRawAliases,
  readRawChannels,
  readRawLimits,
  validateChannelOptions,
  writeRawChannels,
} from "./channels.js";
import { envWithDotFile } from "./dotenv.js";
import { fromCompletion, record } from "./telemetry.js";

/** 测试与拉模型都不该久等——它们是界面上的一次点击。 */
const ADMIN_TIMEOUT_MS = 30_000;

export type AdminDeps = {
  registry: Registry;
  /** 当前生效的渠道表（只读用途，比如测试与拉模型）。 */
  current(): ChannelConfig[];
  /** 重新加载并切换。抛错即表示未切换。 */
  reload(): void;
  /** 走完整条服务链路发一次请求，用于「一键测试」。 */
  chat(channel: ChannelConfig, prompt: string, signal: AbortSignal): Promise<JsonRecord>;
  /** 测试注入用；生产走 channels.json 的默认位置。 */
  path?: string;
};

/**
 * 校验一批**声明**能不能变成一张可服务的表。
 *
 * 与启动时那套是同一组检查（未知键 / 类型 / env 引用 / HTTP 适配器要 baseUrl），
 * 刻意复用而不是另写一份——两份迟早会分叉，而分叉的症状是「界面说保存成功、
 * 重启起不来」。
 */
export function validateDeclared(entries: JsonRecord[], registry: Registry): ChannelConfig[] {
  // `.env` 合进来，和启动时 loadChannels 用的是同一个环境。
  //
  // 原先这里写死 `process.env`，而启动走的是 `envWithDotFile()`——两条路径读
  // 不同的环境，于是出现一个很难自证的症状：网关跑得好好的（启动时从 `.env`
  // 解出了 apiKey），但在界面上保存一份**一个字都没改**的配置却失败，报
  // 「apiKey references env.X, but X is not set」。
  //
  // channels.ts 的注释早已写明为什么 process.env 不够：密钥名由用户自由取，
  // 启动脚本不可能预先 export 它们（gateway.sh 也确实只 grep 了自己认识的两个
  // BCP_* 键）。校验这条路径漏掉了这一步。
  const env = envWithDotFile();
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const channel = parseChannel(entry, index, env);
    if (seen.has(channel.id)) throw new RequestError(`duplicate channel id "${channel.id}"`);
    seen.add(channel.id);
    const adapter = registry.get(channel.adapter);
    if (!adapter) {
      throw new RequestError(
        `channel "${channel.id}" wants adapter "${channel.adapter}", which is not registered — available: ${[...registry.keys()].join(", ")}`,
      );
    }
    validateChannelOptions(channel, adapter);
    if (!isDirect(adapter) && !channel.baseUrl) {
      throw new RequestError(`channel "${channel.id}": adapter "${adapter.name}" requires a baseUrl`);
    }
    return channel;
  });
}

/**
 * 名字里带 KEY / TOKEN / SECRET 一类的才算「可以拿来当 apiKey 用」。
 *
 * 不全量倾泻的理由见 listSecretEnvNames。
 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * 可以被 `env.NAME` 引用的密钥名 —— **只有名字，没有值**。
 *
 * 界面拿它做一个下拉，省掉「我那个 key 到底叫什么来着」这一趟翻 .env。
 *
 * 按名字过滤而不是把 `Object.keys(env)` 整张表发出去：只回名字确实不泄密钥，
 * 但一张完整的环境变量键表会顺带交代这台机器上装了什么、内网服务叫什么、
 * 目录结构长什么样。下拉的用途只是「挑一个密钥引用」，没必要说这么多。
 *
 * 过滤漏掉的（比如有人的 key 就叫 `AIHUB`）不阻塞：那一栏允许手打，下拉是
 * 帮忙不是白名单——和模型那一列同一个立场。
 *
 * 空值的名字排除掉：选了也会在 parseChannel 里 fail closed，不如不给。
 */
export function listSecretEnvNames(
  env: Record<string, string | undefined> = envWithDotFile(),
): string[] {
  return Object.keys(env)
    .filter((name) => SECRET_NAME.test(name) && (env[name] ?? "") !== "")
    .sort();
}

/** 界面要知道有哪些适配器可选，以及每种认哪些 option。 */
export function describeAdapters(registry: Registry): JsonRecord[] {
  return [...registry.values()].map((a) => ({
    name: a.name,
    kind: isDirect(a) ? "direct" : "http",
    // direct 适配器没有 URL 可填，界面据此隐藏那个输入框
    needsBaseUrl: !isDirect(a),
    canListModels: typeof a.listModels === "function",
    options: a.options ?? [],
  }));
}

/** 保存一张新表。校验不过连文件都不碰。 */
export function saveChannels(entries: unknown, deps: AdminDeps): JsonRecord {
  if (!Array.isArray(entries)) throw new RequestError('body must be { "channels": [...] }');
  // 1. 先校验 —— 这一步抛错时，磁盘和内存都还是原样。
  validateDeclared(entries as JsonRecord[], deps.registry);
  // 2. 再落盘（temp + rename，中途崩不会留半个文件）。
  writeRawChannels(entries as JsonRecord[], deps.path);
  // 3. 最后切换。走的是完整的 loadChannels，所以派生的 local 渠道也会重新算。
  deps.reload();
  return { ok: true, channels: readRawChannels(deps.path) };
}

/**
 * 保存用途别名。
 *
 * 顺序与 saveChannels 完全一致（校验 → 落盘 → 切换），但这里的「校验」有一半
 * 只有 `deps.reload()` 做得到：一个别名指得到东西没有，要拿**重新加载后**的
 * 渠道表才知道。所以这里先落盘再由 reload 里的 validateLoaded 把关，reload
 * 抛错就把文件回滚回去——否则界面会收到一个报错，而磁盘上已经躺着一份下次
 * 启动直接起不来的配置。
 */
export function saveAliases(aliases: unknown, deps: AdminDeps): JsonRecord {
  const parsed = parseAliases(aliases);
  const previous = readRawAliases(deps.path);
  patchConfig({ aliases: parsed }, deps.path);
  try {
    deps.reload();
  } catch (error) {
    patchConfig({ aliases: previous }, deps.path);
    throw new RequestError(error instanceof Error ? error.message : String(error));
  }
  return { ok: true, aliases: readRawAliases(deps.path) };
}

/** 保存并发上限。同一套「落盘 → 切换 → 失败回滚」，理由见 saveAliases。 */
export function saveLimits(limits: unknown, deps: AdminDeps): JsonRecord {
  const parsed = parseLimits(limits);
  const previous = readRawLimits(deps.path);
  patchConfig({ limits: parsed }, deps.path);
  try {
    deps.reload();
  } catch (error) {
    patchConfig({ limits: previous }, deps.path);
    throw new RequestError(error instanceof Error ? error.message : String(error));
  }
  return { ok: true, limits: readRawLimits(deps.path) };
}

function pick(deps: AdminDeps, id: string): ChannelConfig {
  const channel = deps.current().find((c) => c.id === id);
  if (!channel) throw new RequestError(`unknown channel "${id}"`, 404);
  return channel;
}

/**
 * 一键测试：走**完整**的服务链路发一次请求。
 *
 * 不是打个 /v1/models 就算数——那只证明上游还活着，不证明这条渠道能出货。
 * 模型名写错、鉴权过期、适配器映射坏掉，全都只在真发一次时才暴露。
 */
export async function testChannel(id: string, deps: AdminDeps): Promise<JsonRecord> {
  const channel = pick(deps, id);
  const started = Date.now();
  const prompt = "只回两个字：收到";
  try {
    const completion = await deps.chat(channel, prompt, AbortSignal.timeout(ADMIN_TIMEOUT_MS));
    const choice = ((completion.choices as JsonRecord[] | undefined)?.[0] ?? {}) as JsonRecord;
    const message = (choice.message ?? {}) as JsonRecord;
    const latencyMs = Date.now() - started;
    // 走完整链路发了一次真请求，就该跟 /v1/chat/completions 一样被记下来——
    // 否则「一键测试」在渠道卡片上显示健康，监控页却好像它从没被调用过。
    record({
      channel: channelLabel(channel),
      adapter: channel.adapter,
      model: channel.model,
      status: "ok",
      httpStatus: 200,
      latencyMs,
      requestPreview: prompt,
      ...fromCompletion(completion),
    });
    return {
      ok: true,
      latencyMs,
      reply: typeof message.content === "string" ? message.content.slice(0, 200) : "",
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    record({
      channel: channelLabel(channel),
      adapter: channel.adapter,
      model: channel.model,
      status: "error",
      errorKind: error instanceof RequestError ? "invalid_request_error" : "upstream_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      latencyMs,
      requestPreview: prompt,
    });
    // 失败也回 200：这是「测试的结果」，不是「测试接口坏了」。界面要显示这段
    // 报错，而不是收到一个自己也要处理的 HTTP 错误。
    return {
      ok: false,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 拉上游支持的模型列表，针对一份**声明** —— 不要求它已经保存。
 *
 * 此前这个接口按 id 走（`/admin/channels/<id>/models`），从**运行中的渠道表**
 * 里 find。于是新建一条渠道必须先保存才看得到模型列表，而保存的前提是先填一个
 * 模型名 —— 鸡生蛋。可事实是：填完 baseUrl 和 apiKey 的那一刻，问上游要列表
 * 所需的一切就已经齐了，跟这条渠道有没有落盘毫无关系。
 *
 * 三个刻意的选择：
 *
 *  1. **走 parseChannel，不直接信 body**。`env.NAME` 必须在这一侧解引用（界面
 *     只知道名字，真值不出这台机器），未知键必须拒 —— 这份声明下一步就要拿去
 *     发一次真实的网络请求。
 *  2. **id / model 在这里无关紧要**，两个都空也照样探。它们回答的是「对外叫
 *     什么」，而这个接口问的是「上游有什么」；草稿里两个都空恰恰是最需要它的
 *     时刻，不能反过来拿它当门槛。
 *  3. **填不全也回 200 + `error`**，不抛。用户正在打字，半截声明是常态不是故障；
 *     界面那一栏本来就在显示这段文字，跟上游自己的报错共用一个通道。
 *
 * 安全边界没有变化：管理面本来就是 loopback 且无鉴权，`PUT /admin/channels`
 * 加 `POST /admin/channels/<id>/test` 早就能用任意 baseUrl + 任意 `env.NAME`
 * 发出站请求。这里只是省掉「先存一次」，不是新开一道门。
 */
export async function probeUpstreamModels(entry: unknown, deps: AdminDeps): Promise<JsonRecord> {
  const raw: JsonRecord =
    entry && typeof entry === "object" && !Array.isArray(entry) ? { ...(entry as JsonRecord) } : {};
  // parseChannel 要求 id 或 model 至少有一个（那是**保存**的前提）。探测不需要
  // 名字，补一个占位的，免得用一条与本次提问无关的规则把请求挡在门外。
  if (!raw.id && !raw.model) raw.id = "(probe)";

  let channel: ChannelConfig;
  try {
    channel = parseChannel(raw, 0, envWithDotFile());
  } catch (error) {
    return { supported: true, models: [], error: error instanceof Error ? error.message : String(error) };
  }

  const adapter = deps.registry.get(channel.adapter);
  if (!adapter?.listModels) {
    return { supported: false, reason: `adapter "${channel.adapter}" cannot enumerate models`, models: [] };
  }
  // 单独判而不是让 baseUrlOf 抛：那句 `channel "(probe)" has no baseUrl` 会把
  // 占位名端到用户脸上，而他真正需要知道的只是「还没填 baseUrl」。
  if (!isDirect(adapter) && !channel.baseUrl) {
    return { supported: true, models: [], reason: "先填 baseUrl —— 得先知道问哪个上游" };
  }
  try {
    return { supported: true, models: await adapter.listModels(channel, AbortSignal.timeout(ADMIN_TIMEOUT_MS)) };
  } catch (error) {
    return {
      supported: true,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
