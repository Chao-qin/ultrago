/**
 * WeClaw MCP tool provider.
 *
 * Exposes weclaw commands as MCP tools that can be registered into the same
 * Streamable HTTP /mcp endpoint the browser tools already use. Each tool
 * delegates to the live WeclawManager — the manager owns the child process.
 *
 * Tools:
 *   - wec_status   : health + bound account
 *   - wec_send_text: text message
 *   - wec_send_image: image (with optional caption)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WeclawManager } from "./weclaw-manager.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  content: [
    { type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` },
  ],
  isError: true,
});

export function resolveRecipient(explicit: string | undefined, fallback: string | undefined): string {
  const recipient = explicit?.trim() || fallback?.trim();
  if (!recipient) {
    throw new Error("No WeChat recipient configured; set default_recipient in user.json or pass to");
  }
  return recipient;
}

/** Tolerant boolean for MCP args: some clients stringify — map "true"/"false"
 * (and "1"/"0") to real booleans, reject anything else. NOT z.coerce.boolean(),
 * whose Boolean() coercion turns "false" into true (would open the confirm gate). */
const looseBool = z.preprocess(
  (v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v),
  z.boolean(),
);

/** Light SSRF guard for wec_send_image: the weclaw binary fetches image_url, so
 * reject obvious loopback/private-IP hosts before delegating. */
function assertSendableImageUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("image_url must be an absolute http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("image_url must be http(s)");
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    throw new Error("refusing to send an image from a loopback/private address");
  }
}

/**
 * Register the three weclaw tools onto an existing McpServer.
 *
 * Use this when the weclaw tools must share a transport with another
 * McpServer's tools (e.g. browser tools): the MCP SDK's
 * StreamableHTTPServerTransport can only be `connect()`ed once, so we can't
 * spin up two McpServers and connect both. Register the tools onto the same
 * server instead.
 */
export function registerWeclawTools(server: McpServer, mgr: WeclawManager): void {
  server.tool(
    "wec_status",
    "Return weclaw sidecar status: phase (stopped/starting/running/stopping), bound wechat account id, binary version, and uptime.",
    {},
    async () => {
      try {
        return text(JSON.stringify(mgr.status(), null, 2));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "wec_send_text",
    "Send a plain text message to a wechat user via weclaw. Omit `to` to use the default recipient from user.json; provide an ilink id to override it.",
    {
      to: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional recipient ilink user id; defaults to WeClaw user.json."),
      text: z.string().min(1).max(4000).describe("Message body."),
    },
    async ({ to, text: body }) => {
      try {
        const r = await mgr.api.sendText({ to: resolveRecipient(to, mgr.defaultRecipient), text: body });
        return text(JSON.stringify(r, null, 2));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "wec_send_image",
    "Send an image (and optional caption) to a wechat user via weclaw. weclaw downloads the image from the URL and uploads it to the wechat CDN.",
    {
      to: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional recipient ilink user id; defaults to WeClaw user.json."),
      image_url: z
        .string()
        .url()
        .describe("Publicly reachable URL of the image (https preferred)."),
      text: z
        .string()
        .max(4000)
        .optional()
        .describe("Optional caption. Sent as a separate text message before the image."),
    },
    async ({ to, image_url, text: caption }) => {
      try {
        assertSendableImageUrl(image_url);
        const r = await mgr.api.sendImage({ to: resolveRecipient(to, mgr.defaultRecipient), text: caption, imageUrl: image_url });
        return text(JSON.stringify(r, null, 2));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
