/**
 * Thin HTTP client for weclaw's /api/send and /health.
 * Mirrors the binary's documented endpoints; all errors are surfaced verbatim.
 */
export interface WecSendTextArgs {
  to: string;
  text: string;
  signal?: AbortSignal;
}

export interface WecSendImageArgs {
  to: string;
  text?: string;
  imageUrl: string;
  signal?: AbortSignal;
}

export interface WecSendResult {
  ok: true;
  /** Echo of the to/text fields for tool-result clarity. */
  to: string;
  text?: string;
  mediaUrl?: string;
}

export class WecClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 10_000) {}

  async health(): Promise<{ ok: true }> {
    const r = await this.request(`${this.baseUrl}/health`, {});
    if (!r.ok) throw new Error(`/health → HTTP ${r.status}`);
    return { ok: true };
  }

  async sendText(args: WecSendTextArgs): Promise<WecSendResult> {
    return this.post("/api/send", { to: args.to, text: args.text }, args.signal);
  }

  async sendImage(args: WecSendImageArgs): Promise<WecSendResult> {
    return this.post("/api/send", {
      to: args.to,
      text: args.text,
      media_url: args.imageUrl,
    }, args.signal);
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<WecSendResult> {
    const r = await this.request(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, signal);
    if (!r.ok) {
      const detail = await safeText(r);
      throw new Error(`POST ${path} → HTTP ${r.status}: ${detail}`);
    }
    return (await r.json()) as WecSendResult;
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`WeClaw request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
