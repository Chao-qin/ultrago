import type { RequestHandler } from "express";

/**
 * Requests the desktop build refuses even from a caller that holds the desktop token.
 *
 * The desktop client manages these itself (its setup page and model step), and its ingress refuses them. But that
 * token is also handed to MCP clients (`/__desktop/mcp`), and a caller holding it can reach this port directly,
 * so the rule is enforced here too. Keep it the same as packages/desktop/src/ingress.mjs.
 */
export function desktopRefusal(method: string, path: string): string | undefined {
  if (process.env.BCP_DESKTOP !== "1") return undefined;
  // Express matches routes case-insensitively, so the check must too.
  const route = path.toLowerCase();
  if (route.startsWith("/api/settings")) return "请在客户端的准备与连接页面管理设置。";
  if (method !== "GET" && route.startsWith("/api/llm/admin")) return "请在客户端的模型方式中配置云 API。";
  return undefined;
}

export const desktopPolicyGuard: RequestHandler = (req, res, next) => {
  const message = desktopRefusal(req.method, req.path);
  if (message) {
    res.status(409).json({ message });
    return;
  }
  next();
};
