# WeClaw Sidecar Package (`@bcp/weclaw`)

Manages the [WeClaw](https://github.com/fastclaw-ai/weclaw) WeChat bridge as a **managed child process** of the ultrago backend, and exposes its **message-sending** commands as **MCP tools** on the same `/mcp` endpoint (port 8788).

## Why

- One MCP endpoint — Claude Code (or any MCP client) and the backend talk to the same WeClaw tools.
- Lifecycle: WeClaw auto-starts with `pnpm dev` and dies with the backend. No separate daemon.
- Config lives in the repo (`config/`) — version-controlled defaults, easy diffs, no surprise in `~/.weclaw/`.
- The binary is downloaded into `bin/` (gitignored) by `scripts/install.sh` — no Go toolchain needed.

## Layout

```
packages/weclaw/
├── bin/weclaw                  # downloaded by install.sh (gitignored)
├── config/
│   ├── config.json             # weclaw agent config (default: noop)
│   └── accounts/               # wechat login state (gitignored)
├── scripts/
│   ├── install.sh              # download latest binary
│   └── update.sh               # upgrade + restart
└── src/
    ├── index.ts                # public re-exports
    ├── config.ts               # env-driven runtime config
    ├── weclaw-manager.ts       # child process: start / stop / status / wait
    ├── weclaw-client.ts        # HTTP client for /api/send + /health
    └── weclaw-mcp.ts           # registers MCP tools: wec_send_text, wec_send_image, wec_status
```

## Quick start

```bash
# one-time: download the binary
pnpm --filter @bcp/weclaw install:bin

# pnpm dev at repo root will auto-start weclaw
pnpm dev
```

On the first `pnpm start` with no saved WeChat account, the stack runs a QR
login right in your terminal (via `weclaw login`) before the backend spawns —
scan once and the credential persists under `config/accounts/`. Without a TTY
(CI etc.) the start aborts early with instructions instead.

Every `pnpm start` also runs a post-boot **session health check**: a few
seconds after the WeChat daemon comes up, `check-session` looks for the
daemon's "session expired" log marker. If the saved session is dead (WeChat
sessions silently expire), the stack tears itself down, drops the stale
credential into `config/accounts.bak-*/` (gitignored), runs a fresh QR login
in your terminal, and restarts automatically — no silent dead-WeChat state.
Without a TTY the check degrades to a warning and the stack stays up. To force
a re-login manually: `pnpm --filter @bcp/weclaw run ensure-login --force`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @bcp/weclaw build` | Compile the TypeScript library into `dist/` (does not touch the binary) |
| `pnpm --filter @bcp/weclaw install:bin` | Download latest weclaw binary to `bin/` |
| `pnpm --filter @bcp/weclaw update:bin` | Upgrade weclaw (re-downloads) |
| `pnpm --filter @bcp/weclaw ensure-login` | Interactive QR login when no account is saved (auto-run by `pnpm start`); `--force` re-login after a session expiry |
| `pnpm --filter @bcp/weclaw check-session` | Post-boot session-health probe (auto-run by `pnpm start`); exits 2 when the session is expired |
| `pnpm --filter @bcp/weclaw verify` | Print sidecar status (binary path, version, bound account) |

The TypeScript library build and the external WeClaw binary are separate
lifecycles. `pnpm build` only emits `dist/`; it never downloads, patches, or
recompiles `bin/weclaw`. Use `install:bin`, `update:bin`, or
`build-external-delivery.sh` for binary management.

### Binary variants & toolchain

`bin/weclaw` can come from two sources — both write the same path, last one wins:

| Source | Command | Has `external_delivery`? | Toolchain needed |
|---|---|---|---|
| Upstream prebuilt | `install:bin` / `update:bin` | ❌ no (upstream release) | none (download) |
| Patched (this repo) | `build-external-delivery.sh` — auto-run by `pnpm start` via `scripts/backend.sh`'s `ensure_weclaw_binary` | ✅ yes | **Go 1.25+** (matches upstream `go.mod`) + git + network |

`pnpm start` builds and caches (keyed by a commit stamp) the **patched** binary,
so any machine running the full WeChat stack needs **Go 1.25+** — this is not
macOS-specific; any OS with Go works. Without Go the build aborts with an
actionable message. `install:bin`'s prebuilt download is upstream-only and does
**not** carry `external_delivery`. Set `BCP_WECLAW_DISABLE=1` to skip WeClaw
entirely (no binary, no Go needed).

## Environment

All overridable via env (defaults shown):

| Var | Default | Meaning |
|---|---|---|
| `WECLAW_BIN` | `<package>/bin/weclaw` | Path to binary (override for system install) |
| `WECLAW_CONFIG_DIR` | `<package>/config` | Where `config.json` and `accounts/` live |
| `WECLAW_API_ADDR` | `127.0.0.1:18011` | Where weclaw's HTTP API binds |
| `WECLAW_DISABLE` | `0` | Set to `1` to skip auto-start (e.g. for tests) |

Create the ignored local file `config/user.json` to set the default MCP
recipient:

```json
{
  "default_recipient": "oXXXXX@im.wechat"
}
```

The MCP `wec_send_text` tool uses this recipient when `to` is omitted. An
explicit `to` remains available for sending to another user.

When managed by the repository stack, WeClaw's `opencode` agent points to the
Gateway ACP Proxy. The proxy forwards ACP sessions to the real OpenCode binary,
while Gateway owns inbound message records and the outbound WeChat Outbox.

## Behavior contract

1. `WeclawManager.start()` is idempotent — calling it twice is a no-op.
2. The manager **waits for the API to respond** before resolving, so callers can immediately use the client.
3. On backend `SIGTERM`/`SIGINT`, the manager forwards the signal to weclaw and waits up to 3s for clean exit.
4. `pnpm start` builds the patched external-delivery binary when the cached stamp is stale (requires Go 1.25+, see above); the pre-flight login gate and the post-boot session check run in the user's foreground terminal, where a QR can be scanned.

## MCP tools exposed

| Tool | Inputs | Effect |
|---|---|---|
| `wec_send_text` | `text`, `to?` (user_id@im.wechat) | Submit a Gateway outbound intent; omitted `to` uses `config/user.json` |
| `wec_send_image` | `to`, `text?`, `image_url` | Send an image |
| `wec_status` | — | Return running state + bound account |

All tools return JSON `{ ok, ... }`. Failures include a human-readable `error` field.
