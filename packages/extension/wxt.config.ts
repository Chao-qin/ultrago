import { defineConfig } from "wxt";

/**
 * WXT config (migrated from CRXJS). WXT owns manifest generation and the
 * cross-browser build: `wxt build` (Chrome) / `wxt build -b firefox`.
 *
 * The side panel entrypoint (src/entrypoints/sidepanel/) is emitted as
 * `side_panel` on Chromium and `sidebar_action` on Firefox automatically.
 */
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  // WXT's development CSP must name the same origin as Vite's injected module
  // and HMR client. Do not let Vite select the next free port, which would make
  // the generated side panel load scripts the manifest CSP does not allow.
  vite: () => ({
    server: { port: 3001, strictPort: true },
  }),
  manifest: ({ browser }) => ({
    name: "UltraGo",
    version: '0.1.7',
    description:
      "Browser executor for an MCP-driven agent: a local Node MCP server drives this browser via WS-RPC.",
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    action: {
      default_title: "UltraGo",
      default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
    },
    // Chrome: a fixed `key` pins the extension ID so chrome.storage survives
    // reloads. Firefox: a gecko id plays the same role (and is required for a
    // stable ID / temporary-load reinstalls).
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: "ultrago@bcp.local" } } }
      : {
          key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq8OayZ9xv/jdGOAgRFpy/JAluIz7T4hqxfqAFhvGesgEUD3af5xk8Q1IfkrXfxrPQdDm/GRQ7qxj14qiCopCUfwAm6yWwUdbTXNvkQHsxRPZi+/Zx9DlvW3WQIcOvSHOoT/JB6VluXFGOWWyfnL8uNkdrkj0F5srKS935I+jEASOqRsur3nqnvORihHSc1Znp9Hj+/8udgEn0QFdLc4VDLMqDaOFjN0nz/JG7psFg4nNh/QUcZ36knrwEOYBAbWaJy5+3LwBtM6ep5euMN8rlKWOV+8A0MkAkSEdbucUQwv04EdS9SIMviJj9mSgxmwxor1whVHCkj9qEUd23qUsFQIDAQAB",
        }),
    // sidePanel is a Chromium-only permission; Firefox's sidebar needs none.
    // webNavigation powers the navigation barrier: an action that triggers a
    // navigation must not return while the old document is tearing down, or the
    // next RPC races the new one. Without it that surfaces as a "DOM target
    // frame is gone" error instead of as synchronization.
    permissions:
      browser === "firefox"
        ? ["tabs", "activeTab", "scripting", "storage", "alarms", "downloads", "webRequest", "webNavigation"]
        : ["tabs", "activeTab", "scripting", "storage", "alarms", "downloads", "webRequest", "webNavigation", "sidePanel", "nativeMessaging"],
    host_permissions: ["<all_urls>"],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval' http://localhost:3001; object-src 'self';",
    },
  }),
});
