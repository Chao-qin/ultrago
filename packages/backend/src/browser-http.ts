/**
 * Internal HTTP surface for browser lifecycle (spec §11.1). Loopback-only,
 * same express app as the internal runner (port 8789). Lifecycle mutations
 * (setup/stop) require X-BCP-Internal-Token — the console reads the same env
 * (BCP_INTERNAL_TOKEN) with the same default. status is read-only.
 */
import { isAbsolute } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { isValidInstanceId, type BrowserSelector, type BrowserSetupRequest } from "@bcp/shared";
import { config } from "./config.js";
import { BrowserSetupService } from "./browser-setup-service.js";
import { BrowserDispatcher } from "./browser-dispatcher.js";
import type { WsServer } from './ws-server.js';

export function createBrowserHttpRouter(setup: BrowserSetupService, dispatcher: BrowserDispatcher, ws?: WsServer): Router {
  const router = Router();

  // Loopback host/origin hardening (same posture as /mcp): only our own
  // loopback names may call in, so a browser page can't CSRF / DNS-rebind.
  // Port is deliberately wildcarded — the internal runner binds whatever
  // BCP_INTERNAL_PORT says, and the check must track it.
  const isLoopbackHost = (h: string): boolean =>
    /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);
  router.use((req, res, next) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!host || !isLoopbackHost(host) || (origin && !isLoopbackHost(origin))) {
      res.status(403).json({ error: "forbidden origin/host" });
      return;
    }
    next();
  });

  const requireToken = (req: Request, res: Response, next: () => void): void => {
    const token = req.headers["x-bcp-internal-token"];
    if (token !== config.internalToken) {
      res.status(401).json({ error: "missing or invalid X-BCP-Internal-Token" });
      return;
    }
    next();
  };

  router.get('/connected', (_req, res) => res.json(ws?.listBrowsers() ?? []));
  router.post('/probe', requireToken, async (req, res) => {
    const { instanceId } = req.body ?? {};
    if (!isValidInstanceId(instanceId) || !ws?.listBrowsers().some((b) => b.kind === 'chrome' && b.instanceId === instanceId && b.ready)) {
      res.status(409).json({ error: 'selected browser is not connected' }); return;
    }
    try { res.json(await dispatcher.bootstrapProbe({ kind: 'chrome', instanceId })); }
    catch (error) { res.status(500).json({ error: dispatcherError(error) }); }
  });

  router.post('/select', requireToken, async (req, res) => {
    const { instanceId } = req.body ?? {};
    if (!isValidInstanceId(instanceId) || !ws?.listBrowsers().some((b) => b.kind === 'chrome' && b.instanceId === instanceId && b.ready)) {
      res.status(409).json({ error: 'selected browser is not connected' }); return;
    }
    try {
      const target = { kind: 'chrome' as const, instanceId };
      const probe = await dispatcher.bootstrapProbe(target);
      if (probe.ok) ws.selectDesktopTarget(target);
      res.json(probe);
    } catch (error) { res.status(500).json({ error: dispatcherError(error) }); }
  });

  /** POST /internal/browsers/policy — runtime browser-tool policy for the desktop client, which starts this
   * process itself and switches settings without restarting it. The values are read on every use.
   * Gated by BCP_POLICY_TOKEN, a secret only the desktop coordinator holds: the internal token is also handed
   * to MCP clients, and the policy is the user's switch, not something the driven assistant may flip back. */
  router.post('/policy', (req, res) => {
    const expected = process.env.BCP_POLICY_TOKEN;
    const given = req.headers['x-bcp-policy-token'];
    // Byte lengths, not string lengths: timingSafeEqual throws on buffers of different sizes, and a non-ASCII
    // header of the right string length would otherwise come back as a 500 instead of a refusal.
    const givenBytes = Buffer.from(typeof given === 'string' ? given : '');
    if (!expected || typeof given !== 'string' || givenBytes.length !== Buffer.byteLength(expected) || !timingSafeEqual(givenBytes, Buffer.from(expected))) {
      res.status(403).json({ error: 'browser-tool policy is managed by the desktop client' }); return;
    }
    const { eval: allowEval, localEval, screenshotDir, cloudCaptcha } = req.body ?? {};
    if (allowEval !== undefined && typeof allowEval !== 'boolean') { res.status(400).json({ error: 'eval must be a boolean' }); return; }
    if (localEval !== undefined && typeof localEval !== 'boolean') { res.status(400).json({ error: 'localEval must be a boolean' }); return; }
    if (cloudCaptcha !== undefined && typeof cloudCaptcha !== 'boolean') { res.status(400).json({ error: 'cloudCaptcha must be a boolean' }); return; }
    if (screenshotDir !== undefined && screenshotDir !== null && (typeof screenshotDir !== 'string' || !isAbsolute(screenshotDir))) {
      res.status(400).json({ error: 'screenshotDir must be an absolute path or null' }); return;
    }
    if (allowEval !== undefined) process.env.BCP_EVAL = allowEval ? 'on' : 'off';
    if (localEval !== undefined) process.env.BCP_LOCAL_EVAL = localEval ? 'on' : 'off';
    if (cloudCaptcha !== undefined) process.env.BCP_CLOUD_CAPTCHA = cloudCaptcha ? 'on' : 'off';
    if (screenshotDir === null) delete process.env.BCP_SCREENSHOT_DIR;
    else if (screenshotDir !== undefined) process.env.BCP_SCREENSHOT_DIR = screenshotDir;
    res.json({ eval: config.evalEnabled, localEval: config.localEvalEnabled, screenshotDir: process.env.BCP_SCREENSHOT_DIR ?? null, cloudCaptcha: config.cloudCaptchaEnabled });
  });

  /** GET /internal/browsers/status?kind=&instanceId= — read-only. Must return
   * candidates even when nothing is connected (never HTTP 500). */
  router.get("/status", async (req, res) => {
    try {
      const q = req.query as { kind?: string; instanceId?: string };
      const selector: BrowserSelector = {};
      if (q.kind === "chrome" || q.kind === "firefox") selector.kind = q.kind;
      if (q.instanceId && isValidInstanceId(q.instanceId)) selector.instanceId = q.instanceId;
      res.json(await setup.status(selector));
    } catch (e) {
      res.status(500).json({ error: dispatcherError(e) });
    }
  });

  /** POST /internal/browsers/setup — lifecycle mutation, token required.
   * mode 缺省为 "user"（安全默认：user 实例永不归后端所有）。 */
  router.post("/setup", requireToken, async (req, res) => {
    const body = (req.body ?? {}) as Partial<BrowserSetupRequest>;
    if (body.kind !== "chrome" && body.kind !== "firefox") {
      res.status(400).json({ error: `kind must be "chrome" or "firefox", got ${JSON.stringify(body.kind)}` });
      return;
    }
    if (body.mode !== undefined && body.mode !== "user" && body.mode !== "managed") {
      res.status(400).json({ error: `mode must be "user" or "managed", got ${JSON.stringify(body.mode)}` });
      return;
    }
    if (body.instanceId !== undefined && !isValidInstanceId(body.instanceId)) {
      res.status(400).json({ error: `invalid instanceId ${JSON.stringify(body.instanceId)}` });
      return;
    }
    try {
      const result = await setup.setup({
        kind: body.kind,
        mode: body.mode ?? "user",
        instanceId: body.instanceId,
        waitMs: body.waitMs,
      });
      const status = result.status;
      if (status.readiness === "unsupported") {
        // Firefox managed etc. — an explicitly unsupported combination.
        res.status(422).json({ target: result.target, status, ready: false, operationId: result.operationId });
        return;
      }
      if (status.lastError && ["ownership_conflict", "profile_locked", "foreign_process", "profile_invalid"].includes(status.lastError.code)) {
        res.status(409).json({ error: status.lastError });
        return;
      }
      // 200 with the current state whether ready or not (never fake failure).
      res.status(200).json({ target: result.target, status, ready: result.ready, operationId: result.operationId });
    } catch (e) {
      res.status(500).json({ error: dispatcherError(e) });
    }
  });

  /** POST /internal/browsers/stop — lifecycle mutation, token required. Only
   * backend-owned managed instances can be stopped. */
  router.post("/stop", requireToken, async (req, res) => {
    const body = (req.body ?? {}) as { kind?: string; instanceId?: string };
    if (body.kind !== "chrome" && body.kind !== "firefox") {
      res.status(400).json({ error: `kind must be "chrome" or "firefox"` });
      return;
    }
    if (!body.instanceId || !isValidInstanceId(body.instanceId)) {
      res.status(400).json({ error: "instanceId is required and must be valid" });
      return;
    }
    try {
      const status = await setup.stop({ kind: body.kind, instanceId: body.instanceId });
      res.status(200).json(status);
    } catch (e) {
      const err = dispatcherError(e);
      const code = typeof err === "string" ? err : (err as { code?: string }).code;
      if (code === "stop_rejected" || code === "foreign_process") {
        res.status(409).json({ error: err });
        return;
      }
      res.status(500).json({ error: err });
    }
  });

  return router;
}

function dispatcherError(e: unknown): unknown {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return e;
  }
  return e instanceof Error ? { code: "internal_error", message: e.message, retryable: false } : String(e);
}

// Keep a reference so the router factory is usable with a different port in tests.
export const BROWSER_INTERNAL_PORT = 8789;
