/**
 * Channel table — the gateway's routing input.
 *
 * A channel is one upstream the gateway is willing to talk to, named by the
 * model id callers ask for. Declared channels live in `channels.json` at the
 * package root; the local one is derived from the runtime profile so that the
 * hardware-driven Ollama/LM Studio choice keeps working without anybody having
 * to restate it in a config file.
 *
 * Secrets are written as `env.NAME` and dereferenced here, so channels.json
 * stays commit-safe and the real keys stay in .env.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RequestError,
  type Adapter,
  type ChannelConfig,
  type ChannelPricing,
  type JsonRecord,
} from "./adapters/types.js";
import { envWithDotFile } from "./dotenv.js";
import { loadEffectiveRuntime, type EffectiveRuntime } from "./runtime-profile.js";

/** Stable public name of whichever local backend is running. */
export const LOCAL_CHANNEL_ID = "local";

const CHANNELS_URL = new URL("../channels.json", import.meta.url);

type Env = Record<string, string | undefined>;

/**
 * Resolve a secret reference.
 *
 * `env.NAME` reads process env and fails closed when it is missing: a channel
 * declared with a credential that does not resolve is a misconfiguration, and
 * discovering it at load time beats discovering it as a 401 from the upstream
 * halfway through a run. Anything without the prefix is used verbatim.
 */
export function resolveSecret(
  raw: string | undefined,
  env: Env,
  where: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw.startsWith("env.")) return raw;
  const name = raw.slice(4);
  const value = env[name];
  if (!value) {
    throw new Error(`${where}: apiKey references ${raw}, but ${name} is not set`);
  }
  return value;
}

function requireString(value: unknown, where: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where}: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * A positive integer, or a clear failure.
 *
 * Same standard as requireString, for the same reason: `maxConcurrency: 0` is
 * not a smaller cap, it is a typo that would park every request against that
 * channel forever. Rejecting it at load time is the only place it stays cheap.
 */
function requirePositiveInt(value: unknown, where: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where}: ${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parse a price pair.
 *
 * Zero is legal — free tiers exist and "declared as free" is a different, more
 * useful statement than "not declared". Negative is not, and neither is a
 * string: `"inputPer1M": "0.5"` would multiply into a string concatenation and
 * produce a cost that looks plausible right up until someone adds it up.
 */
function parsePricing(raw: unknown, where: string): ChannelPricing {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: pricing must be an object`);
  }
  const entry = raw as JsonRecord;
  rejectUnknownKeys(entry, PRICING_KEYS, `${where}.pricing`);
  const rate = (key: "inputPer1M" | "outputPer1M"): number => {
    const value = entry[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `${where}.pricing: ${key} must be a non-negative number, got ${JSON.stringify(value)}`,
      );
    }
    return value;
  };
  return {
    inputPer1M: rate("inputPer1M"),
    outputPer1M: rate("outputPer1M"),
    ...(entry.currency !== undefined
      ? { currency: requireString(entry.currency, `${where}.pricing`, "currency") }
      : {}),
  };
}

/** Capability tags. Free-form by design (see ChannelConfig.capabilities). */
function parseCapabilities(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${where}: capabilities must be an array of strings`);
  }
  return raw.map((tag, i) => requireString(tag, where, `capabilities[${i}]`).trim());
}

const CHANNEL_KEYS = [
  "id",
  "adapter",
  "baseUrl",
  "apiKey",
  "model",
  "options",
  "maxConcurrency",
  "pricing",
  "capabilities",
] as const;

const PRICING_KEYS = ["inputPer1M", "outputPer1M", "currency"] as const;

/**
 * Normalise a key for typo detection: case and separators are where config
 * mistakes actually happen (`num_ctx` for `numCtx`, `baseURL` for `baseUrl`).
 */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reject keys we do not understand, naming the likely intended one.
 *
 * Silently ignoring an unrecognised key is how a config typo turns into wrong
 * behaviour with no error: `modle` leaves `model` defaulting to the channel id,
 * `num_ctx` leaves the context window unset. Both then fail far from their
 * cause. This module already fails closed on an unresolvable `env.NAME`; the
 * same standard belongs here.
 */
export function rejectUnknownKeys(
  entry: JsonRecord,
  known: readonly string[],
  where: string,
): void {
  const byNormalised = new Map(known.map((k) => [normaliseKey(k), k]));
  for (const key of Object.keys(entry)) {
    if (known.includes(key)) continue;
    const suggestion = byNormalised.get(normaliseKey(key));
    throw new Error(
      suggestion
        ? `${where}: unknown key "${key}" — did you mean "${suggestion}"?`
        : `${where}: unknown key "${key}" — valid keys: ${known.join(", ")}`,
    );
  }
}

/**
 * 一条渠道**对外的模型名**：声明了 `id` 就用它，没声明就等于上游 `model`。
 *
 * 这条规则此前只活在 parseChannel 里，于是管理界面为了显示「这条渠道实际叫
 * 什么」只能照抄一份——规则改一处、另一处静默漂移。提到这里，parseChannel 与
 * 管理面 GET 共用同一个实现，界面消费算好的结果而不是自己推。
 */
export function effectiveChannelId(entry: { id?: unknown; model?: unknown }): string {
  const declared = typeof entry.id === "string" ? entry.id.trim() : "";
  const upstream = typeof entry.model === "string" ? entry.model.trim() : "";
  return declared || upstream;
}

/** Parse one declared entry. Unknown keys are rejected, not ignored. */
export function parseChannel(raw: unknown, index: number, env: Env): ChannelConfig {
  const where = `channels[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const entry = raw as JsonRecord;
  rejectUnknownKeys(entry, CHANNEL_KEYS, where);
  // `id` 是**对外的模型名** —— 调用方写进请求 `model` 字段的那个。默认就叫上游
  // 自己的名字（大多数时候你不需要起名）；两条渠道用同一个 id 表示"同一个模型的
  // 多个来源"，请求在它们之间轮流落地。想把两个上游区分开，就给它们不同的 id。
  const upstream = typeof entry.model === "string" ? entry.model.trim() : "";
  const id = effectiveChannelId(entry);
  if (!id) {
    throw new Error(`${where}: 至少要有 model（上游模型名）或 id（对外模型名）`);
  }
  let options: JsonRecord | undefined;
  if (entry.options !== undefined) {
    if (!entry.options || typeof entry.options !== "object" || Array.isArray(entry.options)) {
      throw new Error(`${where}: options must be an object`);
    }
    options = entry.options as JsonRecord;
  }
  return {
    id,
    adapter: requireString(entry.adapter, where, "adapter"),
    // Optional here, required at boot for adapters that speak HTTP: a
    // CLI-backed channel has no URL to give. Checking it there is what lets the
    // error name the adapter that actually needs it.
    ...(entry.baseUrl !== undefined
      ? { baseUrl: requireString(entry.baseUrl, where, "baseUrl").replace(/\/+$/, "") }
      : {}),
    apiKey: resolveSecret(
      typeof entry.apiKey === "string" ? entry.apiKey : undefined,
      env,
      where,
    ),
    // 反过来也成立：只给了 id 没给 model 时，上游按同名请求。
    model: upstream || id,
    ...(options ? { options } : {}),
    ...(entry.maxConcurrency !== undefined
      ? { maxConcurrency: requirePositiveInt(entry.maxConcurrency, where, "maxConcurrency") }
      : {}),
    ...(entry.pricing !== undefined ? { pricing: parsePricing(entry.pricing, where) } : {}),
    ...(entry.capabilities !== undefined
      ? { capabilities: parseCapabilities(entry.capabilities, where) }
      : {}),
  };
}

/**
 * Check a channel's `options` against what its adapter declares.
 *
 * Runs at boot, where the registry is available, so a bad option stops startup
 * instead of quietly changing behaviour on every later request. Adapters that
 * declare nothing are left alone — a custom adapter may accept anything.
 */
export function validateChannelOptions(channel: ChannelConfig, adapter: Adapter): void {
  const specs = adapter.options;
  if (!specs || !channel.options) return;
  const where = `channel "${channel.id}" options`;
  rejectUnknownKeys(
    channel.options,
    specs.map((s) => s.key),
    where,
  );
  for (const spec of specs) {
    const value = channel.options[spec.key];
    if (value === undefined) continue;
    if (typeof value !== spec.type) {
      // `"think": "true"` reads as enabled and behaves as disabled. A wrong
      // type is as silent as a wrong key and deserves the same treatment.
      throw new Error(
        `${where}: "${spec.key}" must be a ${spec.type}, got ${typeof value} (${JSON.stringify(value)})`,
      );
    }
  }
}

/**
 * The local backend as a channel.
 *
 * The public port belongs to the gateway now, so each local runtime sits on its
 * own internal port and is reached only from here.
 */
export function localChannel(runtime: EffectiveRuntime, env: Env): ChannelConfig {
  if (runtime.provider === "lmstudio") {
    return {
      // 对外就叫它自己的模型名 —— 调用方不需要知道"本机后端"这个概念。
      id: runtime.model,
      adapter: "lmstudio",
      baseUrl: `http://127.0.0.1:${env.BCP_LLM_LMSTUDIO_PORT ?? "11436"}`,
      model: runtime.model,
      // LM Studio fixes the context window at `lms load` time; there is nothing
      // per-request to send, and inventing a field would only be noise.
    };
  }
  const numCtx = Number(env.BCP_LLM_NUM_CTX ?? "32768");
  return {
    id: runtime.model,
    adapter: "ollama",
    baseUrl: `http://127.0.0.1:${env.BCP_LLM_OLLAMA_PORT ?? "11437"}`,
    model: runtime.model,
    ...(Number.isInteger(numCtx) && numCtx > 0 ? { options: { numCtx } } : {}),
  };
}

export type LoadChannelsOptions = {
  channelsPath?: string;
  env?: Env;
  runtime?: EffectiveRuntime;
};

/**
 * The effective channel table: declared entries plus the derived local one.
 *
 * A declared `local` wins over the derived one — an explicit statement in the
 * config file should always beat something this module inferred.
 */
/** The channels.json path this package reads and writes. */
export function channelsPath(): string {
  return process.env.BCP_LLM_CHANNELS_PATH || fileURLToPath(CHANNELS_URL);
}

/**
 * The whole config file.
 *
 * Bad JSON throws rather than reading as an empty file: the admin surface shows
 * whatever this returns, and an empty table displayed as the truth is one Save
 * away from becoming the truth.
 */
function readConfigFile(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonRecord | null;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Merge top-level keys, leaving every key not mentioned untouched.
 *
 * This is the only safe way to write this file now that it holds three
 * independently-edited blocks (channels / aliases / limits). Any "write the
 * whole document" save would silently drop the other two, and that loss has no
 * error — it shows up next boot as "where did my aliases go".
 *
 * Still temp-file + rename: a crash mid-write leaving a truncated config takes
 * the whole gateway down on next boot, which is far worse than a rejected edit.
 */
export function patchConfig(patch: JsonRecord, path: string = channelsPath()): void {
  const target = path || channelsPath();
  let existing: JsonRecord = {};
  try {
    existing = readConfigFile(target);
  } catch {
    // Unreadable existing file: we are about to replace it anyway.
  }
  const body = JSON.stringify({ ...existing, ...patch }, null, 2);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${body}\n`);
  renameSync(tmp, target);
}

/**
 * The file as DECLARED, secrets unresolved.
 *
 * The admin surface must edit this, never the loaded table: `parseChannel`
 * dereferences `env.NAME` into the real key, so the in-memory table holds live
 * credentials. Round-tripping through it would print secrets into the config
 * file and out of any API that echoed it back. Raw in, raw out — the key never
 * leaves .env.
 */
export function readRawChannels(path: string | undefined = channelsPath()): JsonRecord[] {
  const list = readConfigFile(path || channelsPath()).channels;
  return Array.isArray(list) ? (list as JsonRecord[]) : [];
}

/** Replace the declared table, keeping aliases / limits / _readme intact. */
export function writeRawChannels(entries: JsonRecord[], path: string = channelsPath()): void {
  patchConfig({ channels: entries }, path);
}

/** The alias block as declared. */
export function readRawAliases(path: string | undefined = channelsPath()): JsonRecord {
  const raw = readConfigFile(path || channelsPath()).aliases;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonRecord) : {};
}

/** The limits block as declared. */
export function readRawLimits(path: string | undefined = channelsPath()): JsonRecord {
  const raw = readConfigFile(path || channelsPath()).limits;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonRecord) : {};
}

export function loadChannels(opts: LoadChannelsOptions = {}): ChannelConfig[] {
  // `.env` under process env — channel secrets are named freely, so no launcher
  // can export them ahead of us (see dotenv.ts).
  const env = opts.env ?? envWithDotFile();
  const path = opts.channelsPath ?? channelsPath();

  const declared: ChannelConfig[] = [];
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const list = (parsed as JsonRecord | null)?.channels;
    if (list !== undefined) {
      if (!Array.isArray(list)) throw new Error(`${path}: "channels" must be an array`);
      list.forEach((entry, i) => declared.push(parseChannel(entry, i, env)));
    }
  }

  // 重名**不是错误**：它就是"同一个模型有多个来源"的表达方式，pickChannel 会在
  // 它们之间轮流落地。想让两个上游各调各的，就给它们不同的 id。
  if (env.BCP_DESKTOP === '1') return declared;
  const declaredIds = new Set(declared.map((c) => c.id));
  const local = localChannel(opts.runtime ?? loadEffectiveRuntime({ env }), env);
  // 本机后端只在没人声明过同名模型时才加进来 —— 你自己配了一条 qwen3.5:4b，
  // 说明你想自己控制它，推导的那条不该再挤进去和它轮询。
  if (!declaredIds.has(local.id)) declared.push(local);
  return declared;
}

/**
 * 配置文件中没有、由当前运行时补入的渠道。
 *
 * `loadChannels` 保证声明渠道保持原始顺序，并且只会把本地运行时渠道追加在末尾；
 * 管理面据此把两类渠道分开返回，保存时只写回前者。
 */
export function managedChannels(declared: JsonRecord[], effective: ChannelConfig[]): ChannelConfig[] {
  return effective.slice(declared.length);
}

/**
 * 一个网关对外承认的模型名。
 *
 * 调用方只认它——「渠道」是内部概念（模型总得知道从哪个地址、用哪把 key 取），
 * 不该出现在任何调用方要写的字段里。
 */
/**
 * 一条渠道的**调试名** —— 日志和管理面用它，调用方永远不用写。
 *
 * `id` 是对外模型名，同一个模型的多个来源共用它，所以光有 id 分不出"这次是哪条
 * 渠道服务的"。加上来源主机就分得出：`gpt-5.6@aihub.top` vs
 * `gpt-5.6@api.openai.com`。出问题时第一个要回答的就是这个问题。
 *
 * 无条件加后缀，不搞"只有重名时才加"——那会让同一条渠道的历史记录前后不一致，
 * 而排查时最不需要的就是"为什么这两行写法不一样"。
 */
export function channelLabel(channel: ChannelConfig): string {
  if (!channel.baseUrl) return `${channel.id}@${channel.adapter}`;
  try {
    return `${channel.id}@${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.id}@${channel.baseUrl}`;
  }
}

export function servedModels(channels: ChannelConfig[]): string[] {
  const seen = new Set<string>();
  for (const c of channels) seen.add(c.id);
  return [...seen];
}

/**
 * 用途别名表。
 *
 * 值是**一串**模型名：`{ "task.vision": ["opencode/...", "qwen3.5:4b"] }`。
 * 第一个是首选，后面的是备胎——首选的所有渠道都失败（且失败是可重试的那类）
 * 时才轮到下一个。单个字符串是它的简写，也是这个字段最早的形态。
 */
export type AliasTable = Record<string, string[]>;

/** 网关级的闸门。渠道级的那一份在 ChannelConfig.maxConcurrency 上。 */
export type GatewayLimits = { maxConcurrency?: number };

const LIMITS_KEYS = ["maxConcurrency"] as const;

/**
 * 解析用途别名。
 *
 * **一层，不递归。** 别名指向别名读起来省事，但环的症状是启动时栈溢出，而这个
 * 文件是人手写的。
 *
 * 这个功能的存在本身需要一句交代：`llm_client.py` 里那条教训写的是「别再引入
 * 稳定别名这种间接层」——当年 `local` 别名失效让整条流水线每一发都是 404，且
 * **不报错在定义处，只报错在调用处**。有罪的不是别名，是没有校验的别名。所以
 * 这里的别名必须过 `validateAliases`，而那一步挂在启动与热加载共用的那条路径
 * 上：指向不存在的模型 = 网关拒绝启动。同一个失败模式从根上不再可能。
 */
export function parseAliases(raw: unknown): AliasTable {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('"aliases" must be an object of { 别名: 模型名 | [模型名…] }');
  }
  const out: AliasTable = {};
  for (const [name, target] of Object.entries(raw as JsonRecord)) {
    const where = `aliases["${name}"]`;
    if (!name.trim()) throw new Error("aliases: 别名不能是空字符串");
    // 字符串是单元素链的简写 —— 这个字段最早只收字符串，老配置必须继续能读。
    const list = Array.isArray(target) ? target : [target];
    if (list.length === 0) {
      throw new Error(`${where}: 至少要指向一个模型`);
    }
    const targets = list.map((item, i) => requireString(item, where, `[${i}]`).trim());
    // 同一个别名里重复列一个模型不是错误，只是没有意义——它第二次出现时那批
    // 渠道刚刚才全部失败过。去重让「备胎链」的长度说的就是真话。
    out[name] = [...new Set(targets)];
  }
  return out;
}

export function parseLimits(raw: unknown): GatewayLimits {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('"limits" must be an object');
  }
  const entry = raw as JsonRecord;
  rejectUnknownKeys(entry, LIMITS_KEYS, "limits");
  return entry.maxConcurrency !== undefined
    ? { maxConcurrency: requirePositiveInt(entry.maxConcurrency, "limits", "maxConcurrency") }
    : {};
}

export function loadAliases(path: string | undefined = channelsPath()): AliasTable {
  return parseAliases(readRawAliases(path));
}

export function loadLimits(path: string | undefined = channelsPath()): GatewayLimits {
  return parseLimits(readRawLimits(path));
}

/**
 * 每个别名都指得到东西，且不会被真实模型名遮住。
 *
 * 两条检查，两种静默失败：
 *  - 目标不存在 → 调用方拿到 404，而配置文件看着完全正常（`local` 那次）。
 *  - 别名与真实模型重名 → `pickChannel` 先匹配真实模型名，于是这条别名**永远
 *    不会生效**，却一声不吭。配错了却"能跑"，比跑不起来更难查。
 */
export function validateAliases(aliases: AliasTable, channels: ChannelConfig[]): void {
  const known = new Set(servedModels(channels));
  for (const [name, targets] of Object.entries(aliases)) {
    if (known.has(name)) {
      throw new Error(`alias "${name}" 与一个真实模型名重名 —— 它永远不会生效，请改名`);
    }
    // 备胎链里的**每一个**都要校验，不只是首选：一条永远指不到东西的备胎，
    // 只会在首选真的挂掉的那一刻才暴露 —— 那正是最不该再出意外的时刻。
    for (const target of targets) {
      if (!known.has(target)) {
        throw new Error(
          `alias "${name}" -> "${target}"，但没有渠道提供 "${target}" —— 可选：${
            [...known].join(", ") || "(none configured)"
          }`,
        );
      }
    }
  }
}

/**
 * 别名换成真实模型名**链**；不是别名就返回它自己（单元素）。
 *
 * 返回数组而不是一个名字，是因为别名可以配备胎：首选挂了要落到下一个。链的
 * 顺序就是尝试顺序。
 */
export function resolveModel(model: string, aliases?: AliasTable): string[] {
  return aliases?.[model] ?? [model];
}

/**
 * 把请求里的 `model` 落到一条能提供它的渠道上。
 *
 * 匹配顺序：**先看模型名**，这是调用方唯一该知道的东西；再看渠道 id，那是给
 * 老调用点留的兼容路径（两个 Python 脚本写的是 `local`）。两者都精确匹配——
 * 模糊或兜底匹配会把一个拼写错误变成"被别的模型悄悄回答了"，那比一个列出可选
 * 项的 404 难查得多。
 *
 * 同一个模型名有多条渠道提供时**轮流用**。这就是"多把 key"的全部需要：不用配
 * 权重、不用起组名，加一条同名渠道就自动分摊。cursor 由调用方持有，所以它随
 * 渠道表热加载一起重置，也让这个函数在测试里仍然是可预测的。
 */
export function pickChannel(
  channels: ChannelConfig[],
  model: unknown,
  cursor?: Map<string, number>,
  aliases?: AliasTable,
): ChannelConfig {
  return candidateChannels(channels, model, cursor, aliases)[0];
}

/**
 * 一个模型名对应的全部渠道，**按本次该用的顺序**排好。
 *
 * 返回整条列表而不是一条，是因为 failover 要的正是「这条不行就换下一条」——
 * 轮询决定从哪条开始，顺序决定失败之后往哪走。`pickChannel` 取它的第一条，于是
 * 会重试的调用方和不会重试的调用方共享同一套轮询语义，不会各转各的游标。
 *
 * 别名配了备胎链时，列表**跨模型拼接**：首选模型的全部渠道排在前面，其后才是
 * 第二个模型的。于是「首选的每条渠道都试过了才动备胎」这件事，不需要 failover
 * 那边知道备胎的存在——它只是照着列表往下走。
 */
export function candidateChannels(
  channels: ChannelConfig[],
  model: unknown,
  cursor?: Map<string, number>,
  aliases?: AliasTable,
): ChannelConfig[] {
  if (typeof model !== "string" || !model) {
    throw new RequestError('"model" must be a non-empty string');
  }
  const targets = resolveModel(model, aliases);
  const out: ChannelConfig[] = [];
  for (const target of targets) {
    const sources = channels.filter((c) => c.id === target);
    if (sources.length === 0) continue;
    if (sources.length === 1 || !cursor) {
      out.push(...sources);
      continue;
    }
    // 轮询游标按**目标模型**各自计数：备胎有它自己的多来源时，它的轮询不该被
    // 首选那边的调用次数带偏。
    const start = (cursor.get(target) ?? 0) % sources.length;
    cursor.set(target, start + 1);
    out.push(...sources.slice(start), ...sources.slice(0, start));
  }
  if (out.length === 0) {
    const known = servedModels(channels).join(", ") || "(none configured)";
    const aliasNames = Object.keys(aliases ?? {});
    const resolved = targets.join(" -> ");
    // 别名解析过就把解析结果也说出来：否则「我明明配了 task.vision」和
    // 「没有渠道提供它指向的那些模型」在同一条 404 里分不开。
    throw new RequestError(
      `unknown model "${model}"${resolved === model ? "" : ` (alias -> ${resolved})`}` +
        ` — available models: ${known}` +
        (aliasNames.length ? `; aliases: ${aliasNames.join(", ")}` : ""),
      404,
    );
  }
  return out;
}
