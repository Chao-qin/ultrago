/**
 * @bcp/weclaw — public entry point.
 * Re-exports for the backend to wire weclaw as a managed MCP sidecar.
 */
export { WeclawManager, getManager } from "./weclaw-manager.js";
export type { WecStatus } from "./weclaw-manager.js";
export { WecClient } from "./weclaw-client.js";
export { registerWeclawTools } from "./weclaw-mcp.js";
export { config, readDefaultRecipient } from "./config.js";
