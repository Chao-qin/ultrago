#!/usr/bin/env bash
#
# @bcp/llm — legacy manager: the managed Ollama server for the ultrago
# stack. Invoked by local-llm.sh (the provider dispatcher); not a public default
# entry point on its own.
#
#   start   install the binary if missing, launch a MANAGED `ollama serve` (nohup),
#           and FAIL (never background-download) when the model is missing
#   stop    stop ONLY the managed instance we started (never a foreign Ollama)
#   status  report port + installed models
#   pull    ensure BCP_LLM_MODEL is pulled (requires a running server)
#   setup   idempotent: binary + server + pull IF MISSING + smoke + snapshot.
#           The only path that may provision a cold store — same contract as
#           lmstudio.sh's setup.
#   ensure  install the binary if missing, start nothing (used by scripts/init.sh)
#
# Ownership rule (mirrors scripts/backend.sh's weclaw guard): we only ever signal
# a process we started. We nohup `$LLM_BIN serve` directly, so the launcher PID
# IS the listener, recorded in $STATE_DIR/.llm.pid. On stop we refuse to touch
# anything unless that PID is alive AND still listening on our port. A foreign
# Ollama already holding the port is never killed, only reported.
#
# Config precedence: process env > $ROOT/.env > defaults.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime state lives in the package dir by default; BCP_LLM_STATE_DIR lets the
# lifecycle regression tests redirect it to a temp dir (production unchanged).
STATE_DIR="${BCP_LLM_STATE_DIR:-$SCRIPT_DIR}"
PID_FILE="$STATE_DIR/.llm.pid"
LOG_FILE="$STATE_DIR/.llm.log"
RUNTIME_FILE="$STATE_DIR/.llm-runtime.json"

env_val() {
  local name="$1"
  local runtime="${!name:-}"
  if [ -n "$runtime" ]; then
    printf '%s' "$runtime"
  else
    { sed -n "s/^$name=//p" "$ROOT/.env" 2>/dev/null || true; } | tail -1 | tr -d ' \r'
  fi
}

BCP_LLM_ENABLE="$(env_val BCP_LLM_ENABLE)"; BCP_LLM_ENABLE="${BCP_LLM_ENABLE:-1}"
# Ollama's OWN port. The public BCP_LLM_PORT belongs to the gateway now; this
# server is an internal backend reached only by the ollama adapter.
BCP_LLM_OLLAMA_PORT="$(env_val BCP_LLM_OLLAMA_PORT)"; BCP_LLM_OLLAMA_PORT="${BCP_LLM_OLLAMA_PORT:-11437}"
BCP_LLM_MODEL="$(env_val BCP_LLM_MODEL)";   BCP_LLM_MODEL="${BCP_LLM_MODEL:-qwen3.5:4b}"
BCP_LLM_NUM_CTX="$(env_val BCP_LLM_NUM_CTX)"; BCP_LLM_NUM_CTX="${BCP_LLM_NUM_CTX:-32768}"
# -1 keeps the model loaded forever (no reload between idle calls); 5m/30m unloads after an idle gap.
BCP_LLM_KEEP_ALIVE="$(env_val BCP_LLM_KEEP_ALIVE)"; BCP_LLM_KEEP_ALIVE="${BCP_LLM_KEEP_ALIVE:--1}"
LLM_BIN="$(env_val BCP_LLM_BIN)"
if [ -z "$LLM_BIN" ]; then LLM_BIN="$(command -v ollama || true)"; fi
[ -n "$LLM_BIN" ] || LLM_BIN="/opt/homebrew/bin/ollama"
# Default host => our port; a caller-set OLLAMA_HOST always wins.
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:$BCP_LLM_OLLAMA_PORT}"

report_llm() { echo "[llm] $*" >&2; }

llm_enabled() { [ "$BCP_LLM_ENABLE" = "1" ]; }

# Ollama ships as a native binary, not an npm package, so `pnpm install` can
# never supply it (the `ollama` dependency is only the JS client SDK). Mirrors
# ensure_weclaw_binary in scripts/backend.sh: idempotent, sits on the start
# path, and skips itself entirely once the binary is in place.
ensure_ollama_binary() {
  if [ -x "$LLM_BIN" ]; then return 0; fi

  case "$(uname -s)" in
    Linux | Darwin) ;;
    *)
      report_llm "Ollama binary not found ($LLM_BIN)."
      report_llm "  fix: install from https://ollama.com/download, or set BCP_LLM_BIN"
      return 1
      ;;
  esac

  report_llm "Ollama binary not found — installing via https://ollama.com/install.sh"
  if ! curl -fsSL https://ollama.com/install.sh | sh >&2; then
    report_llm "install failed — install manually from https://ollama.com/download"
    report_llm "  (Debian/Ubuntu additionally needs: apt-get install -y zstd)"
    return 1
  fi

  LLM_BIN="$(command -v ollama || true)"
  if [ ! -x "$LLM_BIN" ]; then
    report_llm "install script finished but 'ollama' is still not on PATH"
    report_llm "  set BCP_LLM_BIN=/path/to/ollama in .env if it landed elsewhere"
    return 1
  fi
  report_llm "installed: $LLM_BIN"

  # On Linux the official installer also drops a systemd unit that runs
  # `ollama serve` on the default port and enables it at boot. That fights the
  # ownership rule above — we manage our own nohup'd instance on BCP_LLM_OLLAMA_PORT —
  # and when the default port is already taken it just auto-restart-loops
  # forever. We only ever want the binary. Reached only when we just installed
  # it, so this never touches a pre-existing setup.
  if command -v systemctl >/dev/null 2>&1; then
    report_llm "disabling the installer's systemd unit (this script manages its own instance)"
    systemctl disable --now ollama.service >/dev/null 2>&1 ||
      report_llm "  could not disable it — run: sudo systemctl disable --now ollama"
  fi
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_pids() { lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

managed_pid() {
  # Echoes the managed server PID ONLY if: pid file exists, pid alive, and it is
  # listening on our port. Stale/foreign => empty + nonzero (do not touch).
  local pid=""
  if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null || true)"; fi
  case "$pid" in
    ''|*[!0-9]*) echo ""; return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || { echo ""; return 1; }
  local listener
  for listener in $(port_pids "$BCP_LLM_OLLAMA_PORT"); do
    if [ "$listener" = "$pid" ]; then printf '%s' "$pid"; return 0; fi
  done
  echo ""
  return 1
}

port_busy_wait_free() {
  local port="$1"
  for _ in $(seq 1 100); do ! port_busy "$port" && return 0; sleep 0.1; done
  return 1
}

model_present() {
  # Exact name, or prefix match (Qwen images can register under the bare name).
  local name="$1"
  "$LLM_BIN" list 2>/dev/null | awk -v n="$name" '
    NR==1 { next }
    { m=$1; sub(/@.*/,"",m)
      if (m==n || m ~ ("^" n ":")) found=1 }
    END { exit (found?0:1) }
  '
}

# Effective runtime snapshot (spec §7.3) — the one file TypeScript, Python and
# the diagnostics read to agree on what is actually running.
write_snapshot() {
  mkdir -p "$STATE_DIR"
  cat >"$RUNTIME_FILE" <<EOF
{
  "schemaVersion": 1,
  "profile": "legacy-local",
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:$BCP_LLM_OLLAMA_PORT",
  "apiStyle": "ollama",
  "model": "$BCP_LLM_MODEL",
  "contextLength": $BCP_LLM_NUM_CTX,
  "format": "gguf",
  "vision": true,
  "resolvedAt": "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
}
EOF
  report_llm "wrote effective runtime snapshot -> $RUNTIME_FILE"
}

# Everything needed for the server to be LISTENING on our port — binary, launch,
# ownership check. Deliberately a separate function from `start()` because of the
# ordering `setup` needs: a cold store can only be filled by a `pull`, and a pull
# needs a live server, so setup must be able to bring the server up WITHOUT the
# model gate that makes `start` refuse. (Until this split, setup called `start`,
# which returned 1 on a missing model and aborted setup — leaving the pull branch
# below unreachable in exactly the case it was written for.)
bring_up_server() {
  ensure_ollama_binary || return 1

  if port_busy "$BCP_LLM_OLLAMA_PORT"; then
    local mpid
    if mpid="$(managed_pid)"; then
      report_llm "already running (pid $mpid) on port $BCP_LLM_OLLAMA_PORT"
    else
      report_llm "port $BCP_LLM_OLLAMA_PORT is held by a FOREIGN process — not ours to manage"
      report_llm "  set BCP_LLM_OLLAMA_PORT to a free port, or manage that Ollama externally"
      return 1
    fi
  else
    report_llm "starting managed Ollama ($LLM_BIN serve) — logs -> $LOG_FILE"
    cd "$ROOT"
    OLLAMA_FLASH_ATTENTION="1" \
    OLLAMA_KV_CACHE_TYPE="q8_0" \
    OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-$BCP_LLM_KEEP_ALIVE}" \
      nohup "$LLM_BIN" serve >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 200); do port_busy "$BCP_LLM_OLLAMA_PORT" && break; sleep 0.1; done
    if ! port_busy "$BCP_LLM_OLLAMA_PORT"; then
      report_llm "failed to start on port $BCP_LLM_OLLAMA_PORT — see $LOG_FILE"
      rm -f "$PID_FILE"
      return 1
    fi
    report_llm "Ollama listening on 127.0.0.1:$BCP_LLM_OLLAMA_PORT (pid $(cat "$PID_FILE"))"
  fi
  return 0
}

# Provisioning boundary (spec §8.6): `start` never downloads. Missing model =>
# fail loudly and point at the explicit provisioning command.
verify_model_present() {
  if model_present "$BCP_LLM_MODEL"; then
    report_llm "model $BCP_LLM_MODEL present"
    return 0
  fi
  report_llm "model $BCP_LLM_MODEL missing — start refuses to download"
  report_llm "  fix: pnpm --filter @bcp/llm pull   (or: pnpm run llm:setup)"
  return 1
}

start() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  bring_up_server || return 1
  verify_model_present || return 1
  write_snapshot
  return 0
}

stop() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  local pid=""
  if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null || true)"; fi

  local alive=""
  if [ -n "$pid" ]; then alive="$(managed_pid || true)"; fi
  if [ -n "$alive" ]; then
    report_llm "stopping managed Ollama (pid $alive)"
    kill -TERM "$alive" 2>/dev/null || true
    if ! port_busy_wait_free "$BCP_LLM_OLLAMA_PORT"; then
      report_llm "  SIGTERM did not free port — SIGKILL"
      kill -KILL "$alive" 2>/dev/null || true
    fi
  elif [ -n "$pid" ]; then
    report_llm ".llm.pid ($pid) is stale or not on port $BCP_LLM_OLLAMA_PORT — skipping (no kill)"
  fi

  if port_busy "$BCP_LLM_OLLAMA_PORT"; then
    report_llm "warning: port $BCP_LLM_OLLAMA_PORT still held by an unmanaged Ollama — leaving untouched"
  else
    report_llm "Ollama stopped"
  fi
  rm -f "$PID_FILE"
  rm -f "$RUNTIME_FILE"
}

status() {
  if port_busy "$BCP_LLM_OLLAMA_PORT"; then
    echo "port:      $BCP_LLM_OLLAMA_PORT (up, managed pid: $(managed_pid || echo none))"
  else
    echo "port:      $BCP_LLM_OLLAMA_PORT (down)"
  fi
  echo "bin:       $LLM_BIN"
  echo "model:     $BCP_LLM_MODEL"
  echo "--- installed models ---"
  "$LLM_BIN" list 2>/dev/null || echo "(server down)"
}

# Binary-only entry point for scripts/init.sh, which provisions the environment
# but deliberately starts nothing. Honours BCP_LLM_ENABLE so a host that opted
# out of the local LLM never downloads ~1GB it will not use.
ensure() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  ensure_ollama_binary
}

pull() {
  ensure_ollama_binary || return 1
  if ! port_busy "$BCP_LLM_OLLAMA_PORT"; then
    report_llm "Ollama is not running — start it first (pnpm start)"
    return 1
  fi
  report_llm "pulling $BCP_LLM_MODEL (foreground)"
  "$LLM_BIN" pull "$BCP_LLM_MODEL"
}

# Smoke: a minimal non-stream chat round-trip must return HTTP 200. Fail-closed —
# an open TCP port alone does not mean the model answers.
smoke_ok() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$BCP_LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false,\"think\":false}" \
    "http://127.0.0.1:$BCP_LLM_OLLAMA_PORT/api/chat" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

# Idempotent, non-destructive: binary + server + model + smoke + snapshot.
#
# This is the ONLY entry point allowed to provision a cold store: it brings the
# server up first (a pull needs a live server), pulls when the model is absent,
# then smoke-tests — mirroring lmstudio.sh's setup contract. It must therefore
# NOT go through `start`, whose whole point is to refuse that download.
setup() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  bring_up_server || return 1
  if ! model_present "$BCP_LLM_MODEL"; then
    report_llm "pulling $BCP_LLM_MODEL (foreground, setup)"
    "$LLM_BIN" pull "$BCP_LLM_MODEL" || return 1
  fi
  if ! smoke_ok; then
    report_llm "setup: smoke chat against $BCP_LLM_MODEL failed — see $LOG_FILE"
    return 1
  fi
  write_snapshot
  report_llm "setup complete: $BCP_LLM_MODEL loaded and answering on $BCP_LLM_OLLAMA_PORT"
}

case "${1:-}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  pull)   pull ;;
  setup)  setup ;;
  ensure) ensure ;;
  *) echo "usage: $0 {start|stop|status|pull|setup|ensure}" >&2; exit 1 ;;
esac
