import type { Server } from "node:http";
import { desktopReady, desktopAfterActivation } from '@bcp/shared';

import { config } from "./config.js";
import { WsServer } from "./ws-server.js";
import { BrowserSetupService } from "./browser-setup-service.js";
import { BrowserDispatcher } from "./browser-dispatcher.js";
import { createBrowserHttpRouter } from "./browser-http.js";
import { startMcpHttpServer } from "./mcp-http.js";
import { InternalRunner } from "./internal-runner.js";
import { getManager as getWeclawManager } from "@bcp/weclaw";
import type { RawBrowserCall } from "./browser-mcp.js";
import { ConsoleDeliveryClient } from "./console-delivery-client.js";
import { createEventCapture, createEventWebhook } from './event-webhook.js';
import { createCaptchaVerifier } from './captcha-verifier.js';

/**
 * Entry point. One process hosts:
 *   - WS server            — the bridge to the Chrome extension (executes browser tool calls on the real browser)
 *   - HTTP MCP server      — the SSOT browser tools + how-to instructions, consumed by any MCP client (Claude Code, etc.)
 *   - Browser lifecycle    — BrowserSetupService + BrowserDispatcher: instance identity, readiness gate, managed
 *                            profiles/artifacts (spec: docs/superpowers/specs/2026-08-23-browser-readiness-...)
 *   - weclaw sidecar       — managed wechat bridge whose MCP tools ride on the same /mcp endpoint
 *
 *   MCP client (Claude Code, …) ─ http /mcp ─> browser tools ─ dispatcher ─ ws_request ─> extension ─> real browser
 *
 * There is no built-in agent: the perceive→act→verify discipline that used to
 * live in a side-panel Claude runner now travels with the MCP itself (the
 * server's `instructions` + per-tool verify-gate lines), so the connecting
 * agent inherits it.
 */
async function main(): Promise<void> {
  const ws = new WsServer();
  // Browser lifecycle: instance identity + readiness gate. EVERY ordinary
  // browser RPC (MCP tools, internal runs, evidence, cleanup) must go through
  // the dispatcher — direct RpcBridge / ws.callBrowser use is a wiring error.
  const browserSetup = new BrowserSetupService(ws);
  const dispatcher = new BrowserDispatcher(ws, browserSetup);
  let mcpServer: Server | undefined;
  const deliveryClient = new ConsoleDeliveryClient();
  // Lazy delivery bridge: a browser-only backend (no book execution, no
  // leftover outbox) must not spin up the outbox timer or create the outbox
  // dir. The bridge activates on the first terminal book delivery (ingest) or,
  // at boot, only if a previous run left pending outbox files (crash recovery).
  desktopAfterActivation(() => { void deliveryClient.recoverIfPending(); });
  /** Loopback-only runner consumed by @bcp/console — does NOT change the
   *  public MCP /mcp surface. Same PlanRunner + same WsServer as MCP. */
  const internal = new InternalRunner(
    ws,
    ws.events,
    dispatcher,
    deliveryClient,
    createBrowserHttpRouter(browserSetup, dispatcher, ws),
  );

  // Browser tool calls (from either client) -> dispatcher (readiness gate) ->
  // RPC into the extension. Target is REQUIRED at this boundary — the per-session
  // / per-run target resolution happens in browser-mcp / internal-runner.
  const call: RawBrowserCall = (method, params, target) => dispatcher.dispatch(target, method, params as Record<string, unknown>);

  // Realtime event webhook (opt-in). Subscribed HERE rather than inside an MCP
  // session on purpose: a challenge has to reach the user even when no agent is
  // connected — which is exactly when nobody is draining the event buffer.
  if (config.eventWebhook) {
    ws.events.onEvent(
      createEventWebhook(config.eventWebhook, createEventCapture(call, {
        list: () => ws.listBrowsers(),
        getMode: (instanceId) => ws.getMode(instanceId),
      }), { verify: createCaptchaVerifier() }),
    );
    console.log(`[backend] event webhook → ${config.eventWebhook}`);
  }

  // Weclaw sidecar — spawn the binary as a child process and wait for its
  // /health endpoint to come up. If the binary is missing we warn but don't
  // crash: the backend still serves browser tools, just without wechat bridge.
  const weclaw = getWeclawManager();
  if (!config.weclawDisabled) {
    try {
      const status = await weclaw.start();
      console.log(
        `[backend] weclaw: ${status.phase} pid=${status.pid} account=${status.account ?? "(none)"}`,
      );
    } catch (e) {
      console.warn(
        `[backend] weclaw sidecar not started: ${e instanceof Error ? e.message : String(e)}`,
      );
      console.warn(
        `[backend]   hint: run \`pnpm --filter @bcp/weclaw install:bin\` then restart.`,
      );
    }
  } else {
    console.log("[backend] weclaw: disabled (BCP_WECLAW_DISABLE=1)");
  }

  let shuttingDown = false;
  // Forward SIGTERM/SIGINT to the managed sidecars for clean shutdown.
  const shutdown = async (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[backend] received ${sig}, shutting down…`);
    try {
      await internal.close();
      await browserSetup.close();
      await ws.close();
      await closeHttpServer(mcpServer);
      deliveryClient.stop();
      await weclaw.stop();
    } catch (e) {
      console.warn(`[backend] weclaw stop error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // The single tool endpoint every MCP client connects to. weclaw's send tools
  // (when the sidecar is up) are mounted onto the same /mcp session.
  mcpServer = await startMcpHttpServer(call, config.mcpPort, ws.events, weclaw, {
    list: () => ws.listBrowsers(),
    validate: (target) => ws.validate(target),
    current: () => ws.current(),
    getMode: (instanceId) => ws.getMode(instanceId),
    setMode: (target, mode) => ws.setMode(target, mode),
    setClaim: (sessionId, target, tabId, since) => ws.setClaim(sessionId, target, tabId, since),
    clearClaim: (sessionId) => ws.clearClaim(sessionId),
    listClaims: () => ws.listClaims(),
  }, deliveryClient, { dispatcher, setup: browserSetup });

  // Internal-runner listens on its own loopback port (BCP_INTERNAL_PORT,
  // default 8789). Console calls POST /internal/run to start a playbook and
  // polls GET /internal/run/:planId for progress.
  const internalPort = await internal.listen();
  const wsPort = await ws.listening();
  const mcpAddress = mcpServer?.address();
  if (typeof mcpAddress !== 'object' || !mcpAddress) throw new Error('MCP did not bind');
  desktopReady('backend', {
    ws: `ws://127.0.0.1:${wsPort}`,
    mcp: `http://127.0.0.1:${mcpAddress.port}`,
    internal: `http://127.0.0.1:${internalPort}`,
  });

  console.log(`[backend] ultrago v${config.serverVersion}`);
  console.log(`[backend] extension WS: ws://127.0.0.1:${wsPort}  |  MCP: http://127.0.0.1:${mcpAddress.port}/mcp`);
  if (config.token === "bcp-dev-token") {
    console.warn("[backend] ⚠ using the default dev token — set BCP_TOKEN to a secret before exposing beyond localhost");
  } else {
    console.log("[backend] token: (custom, from BCP_TOKEN)");
  }
}

async function closeHttpServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 5_000)),
  ]);
}

main().catch((e) => {
  console.error("[backend] fatal:", e);
  process.exit(1);
});
