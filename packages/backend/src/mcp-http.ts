import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { desktopHttpGuard } from '@bcp/shared';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBrowserMcpServer, type BrowserLifecycle, type BrowserRegistry, type RawBrowserCall } from "./browser-mcp.js";
import type { EventStore } from "./event-store.js";
import { registerWeclawTools, type WeclawManager } from "@bcp/weclaw";
import type { DeliverySink } from "./console-delivery-client.js";

/**
 * Serve the browser tools over Streamable HTTP MCP with session management.
 * This is the single tool endpoint every MCP client connects to (e.g. Claude
 * Code via `claude mcp add --transport http`). Each session gets its own
 * McpServer; all forward to the extension over WS-RPC (pure chrome.* APIs, no CDP).
 *
 * When `weclaw` is passed, a SECOND McpServer exposing wechat tools is mounted
 * on the same /mcp path. Both tools appear under the same session — clients
 * see one combined tool list.
 */
export function startMcpHttpServer(
  call: RawBrowserCall,
  port: number,
  eventStore: EventStore,
  weclaw?: WeclawManager,
  browsers?: BrowserRegistry,
  deliverySink?: DeliverySink,
  lifecycle?: BrowserLifecycle,
): Promise<Server> {
  const app = express();
  app.use(desktopHttpGuard);
  app.use(express.json({ limit: "16mb" }));

  // Loopback-only hardening. This endpoint has no auth beyond its 127.0.0.1 bind,
  // so defend the two browser-reachable attack classes:
  //   - CSRF: a malicious page POSTing here carries an Origin header we don't own.
  //   - DNS rebinding: the attacker's domain resolves to 127.0.0.1 but its Host
  //     header isn't our loopback name.
  // Legitimate MCP clients (Claude Code, other local MCP clients) send no Origin and a localhost Host.
  const allowedOrigins = new Set<string>();
  const allowedHosts = new Set<string>();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    // Fail closed on Host: a legitimate local client always sends a loopback
    // Host, so reject when it's absent or not one of ours — a non-browser local
    // process can't reach /mcp header-less. Origin, when present (browser
    // requests), must also be ours; MCP clients send none.
    if (!host || !allowedHosts.has(host) || (origin && !allowedOrigins.has(origin))) {
      res.status(403).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "forbidden origin/host" } });
      return;
    }
    next();
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;
    let created: StreamableHTTPServerTransport | undefined;

    try {
      if (!transport) {
        if (!isInitializeRequest(req.body)) {
          // Unknown/stale session (e.g. after a server restart). Per the MCP spec,
          // 404 tells the client to re-initialize instead of failing hard.
          res.status(404).json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Session not found; re-initialize." },
          });
          return;
        }
        transport = created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, created!);
          },
        });
        transport.onclose = () => {
          if (created!.sessionId) transports.delete(created!.sessionId);
        };
        // One McpServer per session, with both browser + (optionally) wechat
        // tools registered onto it. The MCP SDK's StreamableHTTPServerTransport
        // can only be connected once — running two McpServers against the same
        // transport trips "Transport already started". Merging keeps the
        // session single-server and the tool list combined for the client.
        const server = createBrowserMcpServer(call, eventStore, browsers, deliverySink, lifecycle);
        if (weclaw) registerWeclawTools(server, weclaw);
        await server.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      // A transport created this request that never got registered would leak — tear it down.
      if (created && (!created.sessionId || !transports.has(created.sessionId))) {
        await created.close().catch(() => {});
      }
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e) } });
      }
    }
  });

  // DELETE (terminate) reuses the session's transport.
  const bySession: express.RequestHandler = async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(404).json({ error: "Session not found; re-initialize." });
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.delete("/mcp", bySession);

  // GET is dual-purpose. A real MCP client only ever GETs /mcp with the
  // mcp-session-id it received from initialize (to open its SSE stream);
  // that path goes through bySession above and keeps spec semantics — a
  // stale/unknown session returns 404 so the client re-initializes.
  // A GET WITHOUT a session id is not an MCP client at all: it's a liveness
  // probe (curl, port scanners, connector trust checks). Answering those with
  // a bare 404 made a healthy server look dead, so return a plain health
  // payload instead. It carries no protocol meaning and no session state.
  app.get("/mcp", async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid) {
      res.status(200).json({
        ok: true,
        service: "ultrago",
        transport: "streamable-http",
        hint: "POST an MCP initialize request to open a session",
      });
      return;
    }
    const transport = transports.get(sid);
    if (!transport) {
      res.status(404).json({ error: "Session not found; re-initialize." });
      return;
    }
    await transport.handleRequest(req, res);
  });

  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      for (const host of ['127.0.0.1', 'localhost']) {
        allowedHosts.add(`${host}:${boundPort}`);
        allowedOrigins.add(`http://${host}:${boundPort}`);
      }
      console.log(`[mcp] streamable-http on http://127.0.0.1:${boundPort}/mcp`);
      resolve(server);
    });
    server.once("error", reject);
  });
}
