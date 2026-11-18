import type { BrowserEvent, BrowserTarget } from '@bcp/shared';
import type { CaptchaVerifier } from './captcha-verifier.js';
import type { RawBrowserCall } from './browser-mcp-types.js';
import { captureBrowserScreenshot } from './browser-screenshot.js';

/**
 * event-webhook.ts — realtime push of the few browser events that are only
 * actionable while they are still happening.
 *
 * Deliberately NOT the durable delivery path (console's SQLite queue + retry):
 * the whole value of "a CAPTCHA is blocking you" is that it arrives NOW. A
 * redelivery that finally succeeds ten minutes later announces a challenge
 * that has already timed out — the retry machinery would be pure cost. So:
 * one attempt, no queue, failures logged and dropped. Book-run deliveries keep
 * using the durable path, where "must eventually arrive" IS the requirement.
 *
 * CAPTCHA events are candidates until a local visual verifier confirms them.
 * The event body stays intact, with the verified screenshot attached.
 */

/** Events worth pushing unprompted. Everything else (navigation, dom_changed,
 * console_error…) is high-volume and still readable from the seq buffer
 * afterwards; these are the ones nobody learns about unless they are told. */
const NOTIFY_KINDS: ReadonlySet<string> = new Set(["captcha_appeared", "captcha_cleared", "browser_offline"]);

/** Only a challenge APPEARING is worth an image. "cleared" and "offline" have
 * nothing to look at, and a capture costs an RPC round-trip into the browser. */
const CAPTURE_KINDS: ReadonlySet<string> = new Set(["captcha_appeared"]);

const CAPTURE_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 5_000;

/** How long to let the challenge finish painting before shooting it.
 *
 * The probe fires on the frame the challenge becomes BLOCKING, which is the
 * frame its container lands — the puzzle image is still loading and the open
 * animation is still running. Shooting right then returns a half-rendered card.
 * That used to be masked: confidence churn re-fired the event two or three
 * times, and one of the later shots happened to catch the settled page. Now
 * that the event is correctly edge-triggered there IS only one shot, so it has
 * to be the right one.
 *
 * 800ms is measured, not derived: the challenge that prompted this took ~1s
 * from container to settled, and the two useless shots landed inside the first
 * 700ms of it. A single wait rather than a retry loop, because this whole file
 * is a one-attempt path by design (see the header) — and a human needs tens of
 * seconds to reach the challenge anyway, so the delay costs nothing where it
 * matters. Injectable so tests assert the ordering instead of sleeping. */
const CAPTURE_SETTLE_MS = 800;

/** Screenshot RPC result. `warning` set means captureVisibleTab shot a
 * DIFFERENT tab than the one asked for (the target was a background tab in its
 * window), so the image is of an unrelated page. null = no browser to ask. */
export type CaptureResult = { dataUrl: string; warning?: string } | null;

export type CaptureFn = (browser: string | undefined, tabId: number) => Promise<CaptureResult>;

export function createEventCapture(
  call: RawBrowserCall,
  browsers: { list: () => BrowserTarget[]; getMode: (instanceId: string) => 'auto' | 'manual' },
): CaptureFn {
  return async (browser, tabId) => {
    const target = browsers.list().find((info) => info.instanceId === browser);
    if (!target) return null;
    return captureBrowserScreenshot(call, target, { tabId, compress: true },
      (instanceId) => browsers.getMode(instanceId));
  };
}

/** Only a candidate that the local visual verifier confirms is pushed — every
 *  `captcha_appeared` is a DOM estimate until then. The driving agent never
 *  sees these events at all (isAgentHiddenEvent). */
export function shouldNotify(e: { kind: string }): boolean {
  return NOTIFY_KINDS.has(e.kind);
}

/** The event verbatim, plus a screenshot when one could be taken AND is of the
 * right tab. A wrong image is worse than none: the receiver would judge the
 * challenge from a page that is not the blocked one, so a warned capture is
 * dropped rather than shipped with a caveat nobody reads. */
export async function buildPayload(
  e: BrowserEvent,
  capture?: CaptureFn,
  settleMs: number = CAPTURE_SETTLE_MS,
): Promise<Record<string, unknown>> {
  if (!capture || !CAPTURE_KINDS.has(e.kind) || e.tabId < 0) return { ...e };
  // Deliberately AFTER the "is this worth an image" checks: the kinds that get
  // no screenshot must not pay the wait.
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  let shot: CaptureResult = null;
  try {
    shot = await withTimeout(capture(e.browser, e.tabId), CAPTURE_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[event-webhook] screenshot failed for ${e.kind} tab ${e.tabId}: ${errText(err)}`);
  }
  if (shot?.warning) {
    console.warn(`[event-webhook] screenshot dropped for ${e.kind} tab ${e.tabId}: ${shot.warning}`);
    return { ...e };
  }
  return shot ? { ...e, screenshot: shot.dataUrl } : { ...e };
}

type Candidate = {
  event: BrowserEvent;
  controller: AbortController;
  delivery?: Promise<boolean>;
};

export function createEventWebhook(
  url: string,
  capture?: CaptureFn,
  options: { verify?: CaptchaVerifier; settleMs?: number } = {},
): (e: BrowserEvent) => Promise<void> {
  const candidates = new Map<string, Candidate>();
  const deliveries = new Map<string, Promise<void>>();
  const enqueue = (
    key: string,
    payload: Record<string, unknown>,
    shouldSend: () => boolean | Promise<boolean>,
  ): Promise<boolean> => {
    const delivery = (deliveries.get(key) ?? Promise.resolve()).then(async () => {
      if (!await shouldSend()) return false;
      await post(url, payload);
      return true;
    }).catch((error: unknown) => {
      console.warn(`[event-webhook] ${payload.kind} → ${url} failed: ${errText(error)}`);
      return false;
    });
    const tail = delivery.then(() => {
      if (deliveries.get(key) === tail) deliveries.delete(key);
    });
    deliveries.set(key, tail);
    return delivery;
  };
  const retire = (key: string, candidate: Candidate): void => {
    candidates.delete(key);
    candidate.controller.abort();
  };

  return async (e) => {
    try {
      if (e.kind === 'navigation_started' || e.kind === 'navigation'
        || e.kind === 'tab_closed' || e.kind === 'browser_offline') {
        for (const [key, candidate] of candidates) {
          if (candidate.event.browser === e.browser
            && (e.kind === 'browser_offline' || candidate.event.tabId === e.tabId)
            && (e.kind !== 'navigation_started' || !e.detail?.frameId
              || candidate.event.detail?.frameId === e.detail.frameId)) retire(key, candidate);
        }
      }
      if (!shouldNotify(e)) return;
      const frameId = typeof e.detail?.frameId === 'number' ? e.detail.frameId : 0;
      const key = JSON.stringify([e.browser ?? '', e.tabId, frameId]);
      if (e.kind === 'captcha_cleared') {
        const candidate = candidates.get(key);
        if (!candidate) return;
        retire(key, candidate);
        // 解除必须先占据发送顺序，再等出现通知；否则下一轮出现会插到旧解除之前。
        if (candidate.delivery) await enqueue(key, { ...e }, () => candidate.delivery ?? false);
        return;
      }
      if (e.kind !== 'captcha_appeared') {
        await post(url, { ...e });
        return;
      }
      if (candidates.has(key)) return;
      const candidate: Candidate = { event: e, controller: new AbortController() };
      candidates.set(key, candidate);
      // 丢失关闭事件或长期断线时，去重状态也必须有界。
      if (candidates.size > 512) {
        const oldest = candidates.entries().next().value;
        if (oldest) retire(...oldest);
      }
      if (!options.verify) throw new Error('CAPTCHA verifier is unavailable; notification suppressed');
      const payload = await buildPayload(e, capture, options.settleMs);
      if (candidate.controller.signal.aborted) return;
      if (typeof payload.screenshot !== 'string') throw new Error('No usable CAPTCHA screenshot; notification suppressed');
      const verdict = await options.verify(payload.screenshot, candidate.controller.signal);
      if (candidate.controller.signal.aborted) return;
      if (verdict.isCaptcha !== true) {
        console.warn(`[event-webhook] CAPTCHA ignored for tab ${e.tabId}: ${verdict.reason}`);
        return;
      }
      candidate.delivery = enqueue(key, payload, () => !candidate.controller.signal.aborted);
      await candidate.delivery;
    } catch (error) {
      console.warn(`[event-webhook] ${e.kind} tab ${e.tabId} suppressed: ${errText(error)}`);
    }
  };
}

async function post(url: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
