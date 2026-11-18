/**
 * 把每次调用推给 console，供 /llm 页面展示。
 *
 * 三条不可让渡的纪律，全都指向同一件事：**埋点绝不能影响服务**。
 *
 *   1. 不 await —— 调用方等的是模型的回答，不是我们的日志落库。
 *   2. 不抛 —— 这里的任何异常都会变成一次本可成功的请求失败。
 *   3. 不重试 —— 与 backend 的 event-webhook 同一立场：一次投递，失败就丢。
 *      日志少一行是小事，把网关拖成串行才是事故。
 *
 * console 不在时也不刷屏：连续失败只警告一次，成功后重新武装。一个跑在没起
 * console 的机器上的网关，不该每秒往日志里灌一行同样的话。
 */
import type { ChannelPricing, JsonRecord } from "./adapters/types.js";

const DEFAULT_URL = "http://127.0.0.1:8790/internal/llm-calls/hook";

/** 推送本身的超时。它比请求短得多——日志迟到就没意义了。 */
const TIMEOUT_MS = 3_000;

/** 预览截断长度。接收端还会再截一次，这里截是为了别在网络上搬无用的字节。 */
const PREVIEW_CHARS = 2000;

export type CallRecord = {
  channel?: string;
  adapter?: string;
  model?: string;
  stream?: boolean;
  status: "ok" | "error";
  httpStatus?: number;
  errorKind?: string;
  errorMessage?: string;
  latencyMs?: number;
  ttfbMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestPreview?: string;
  responsePreview?: string;
  startedAt?: number;
  /**
   * 谁打的这一发。
   *
   * 来自请求头 `X-BCP-Caller`，认证开启时回落到那把 key 的名字。
   *
   * 这个字段是整张表里唯一能回答「**哪条流程**在超时 / 在烧钱」的东西。在它
   * 之前，captcha 校验、商品预处理、console 流程三类调用在监控页上混成一锅，
   * 只能按模型和渠道分——而那两个维度回答的是「打给谁」，不是「谁在打」。
   */
  caller?: string;
  /**
   * 本次调用的花费，单位是**货币的百万分之一**（micro）。
   *
   * 用整数而不是浮点：金额相加是这张表最主要的聚合方式，而浮点求和会在几万
   * 条之后开始漂。选 micro 这个刻度是因为它让换算恰好抵消——单价按「每 100 万
   * token」报价，于是 `tokens × 单价` 直接就是 micros，中间没有任何除法。
   */
  costMicros?: number;
  /** 上面那个数字的货币。**不记就不能求和** —— 把 USD 和 CNY 加在一起得到的
   *  数字看起来完全正常，却没有任何意义。 */
  costCurrency?: string;
  /**
   * 这是第几次尝试（1 起）。
   *
   * failover 每换一条渠道就单独记一条，靠这个字段串起来。不记的话，一个「一半
   * 时间在 429、另一半被重试救回来」的上游在监控页上看着完全健康 —— 那正是
   * 重试最容易掩盖掉的事实。
   */
  attempt?: number;
};

/**
 * 一次调用的花费，micro 为单位。
 *
 * `tokens × 每百万单价` 直接就是 micros：单价的分母（1e6 个 token）与 micro 的
 * 分母（1e6 分之一货币）恰好抵消，所以这里没有除法，也就没有除法带来的精度损失。
 *
 * 任一侧缺失就返回 undefined，**不补零**：与这张表其余字段同一条纪律。一个报
 * 不出 usage 的上游（opencode 一个都不报）应该显示为「未知」，显示成 0 会让
 * 「免费」和「不知道」在任何汇总里变成同一件事。
 */
export function costOf(
  usage: { promptTokens?: number; completionTokens?: number },
  pricing: ChannelPricing | undefined,
): { costMicros: number; costCurrency?: string } | undefined {
  if (!pricing) return undefined;
  const { promptTokens, completionTokens } = usage;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return undefined;
  return {
    costMicros: Math.round(
      promptTokens * pricing.inputPer1M + completionTokens * pricing.outputPer1M,
    ),
    ...(pricing.currency ? { costCurrency: pricing.currency } : {}),
  };
}

function endpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.BCP_LLM_TELEMETRY_URL ?? "").trim();
  // 显式置空 = 关掉埋点。这是唯一的关法，比再加一个 ENABLE 变量少一个状态。
  if (raw === "off" || raw === "0") return null;
  return raw || DEFAULT_URL;
}

/** 截断并归一空串。 */
export function preview(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}…` : trimmed;
}

/** 从一个 OpenAI 完成体里取 usage 与正文预览。缺什么就是什么，不补零。 */
export function fromCompletion(payload: JsonRecord | undefined): Partial<CallRecord> {
  if (!payload) return {};
  const usage = (payload.usage ?? {}) as JsonRecord;
  const choice = ((payload.choices as JsonRecord[] | undefined)?.[0] ?? {}) as JsonRecord;
  const message = (choice.message ?? {}) as JsonRecord;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
    responsePreview: preview(message.content),
  };
}

/** 提示词预览：取最后一条 user 消息，那是"这次到底问了什么"。 */
export function fromRequest(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const record = m as JsonRecord;
    if (record.role !== "user") continue;
    if (typeof record.content === "string") return preview(record.content);
    // 多模态：只取文本片段，图片的 base64 没有预览价值还很大。
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((p): p is JsonRecord => !!p && typeof p === "object")
        .filter((p) => p.type === "text")
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("");
      return preview(text);
    }
  }
  return undefined;
}

let warned = false;

/**
 * 推一条记录。**同步返回，不可 await**。
 *
 * 返回 void 而不是 Promise 是刻意的类型层防线：调用点想 await 都 await 不到，
 * 也就不会有人"顺手"把它加进请求路径的关键链上。
 */
export function record(entry: CallRecord, env: NodeJS.ProcessEnv = process.env): void {
  const url = endpoint(env);
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(() => {
      warned = false;
    })
    .catch((error: unknown) => {
      if (warned) return;
      warned = true;
      console.error(
        `[llm-gateway] 调用日志推送失败（后续同类失败不再重复报）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
}
