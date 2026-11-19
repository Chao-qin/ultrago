#!/usr/bin/env bash
#
# @bcp/llm — the managed opencode server. Invoked by local-llm.sh; not a public
# entry point on its own.
#
#   start   launch a MANAGED `opencode serve` (nohup) on BCP_LLM_OPENCODE_PORT
#   stop    stop ONLY the instance we started (never the developer's own)
#   status  report port + isolation paths
#
# WHY THIS EXISTS AS A SCRIPT rather than a child process of the gateway:
# `pnpm kill` walks scripts, not process trees. A server spawned from inside the
# gateway's Node process would survive `gateway.sh stop` (which SIGTERMs one PID)
# and become an orphan holding a port — the "killed the wrapper, left the worker"
# failure this repo has already produced twice. Being a peer of ollama.sh is what
# makes `pnpm kill` able to reap it.
#
# ISOLATION. This server must not be confused with the opencode the developer
# runs themselves. Three env vars do that, and all three are load-bearing:
#
#   HOME             -> $FAKE_HOME   keeps ~/.claude/CLAUDE.md (~29KB of
#                                    irrelevant context) out of every prompt
#   XDG_CONFIG_HOME  -> under it     keeps the developer's opencode.json — which
#                                    declares MCP servers and agents — from
#                                    handing tools back to a channel that is
#                                    supposed to be a plain LLM
#   XDG_DATA_HOME    -> under it     keeps our throwaway sessions out of the real
#                                    ~/.local/share/opencode/opencode.db (391MB
#                                    of the developer's own history at the time
#                                    this was written), and avoids two processes
#                                    contending for one SQLite file
#
# Setting only HOME is NOT enough to rely on: opencode resolves some paths from
# HOME and some from XDG, and which wins is not ours to depend on. Setting all
# three makes the answer the same either way.
#
# The working directory is a bare directory for the same class of reason:
# opencode reads AGENTS.md and project files relative to its cwd, so starting it
# anywhere near a real repo leaks that repo into the prompt.
#
# Ownership rule (mirrors ollama.sh): we only ever signal a process we started.
# On stop we refuse to touch anything unless our PID is alive AND still listening
# on our port. A foreign opencode already holding the port is reported, never
# killed.
#
# Config precedence: process env > $ROOT/.env > defaults.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BCP_LLM_STATE_DIR:-$SCRIPT_DIR}"
PID_FILE="$STATE_DIR/.opencode.pid"
LOG_FILE="$STATE_DIR/.opencode.log"
FAKE_HOME="$STATE_DIR/.opencode-home"
WORK_DIR="$STATE_DIR/.opencode-workdir"
# Source of the agent definition + preamble that make opencode behave as a plain
# LLM. Always read from the package (never $STATE_DIR): the lifecycle tests
# redirect state to a temp dir, but these are shipped files, not state.
BUNDLED_DIR="$SCRIPT_DIR/../opencode-sandbox"

env_val() {
  local name="$1"
  local runtime="${!name:-}"
  if [ -n "$runtime" ]; then
    printf '%s' "$runtime"
  else
    { sed -n "s/^$name=//p" "$ROOT/.env" 2>/dev/null || true; } | tail -1 | tr -d ' \r'
  fi
}

BCP_LLM_ENABLE="$(env_val BCP_LLM_ENABLE)"; BCP_LLM_ENABLE="${BCP_LLM_ENABLE:-0}"
# Must agree with src/adapters/opencode.ts, which reads the same variable.
BCP_LLM_OPENCODE_PORT="$(env_val BCP_LLM_OPENCODE_PORT)"; BCP_LLM_OPENCODE_PORT="${BCP_LLM_OPENCODE_PORT:-11438}"
OPENCODE_BIN="$(env_val BCP_LLM_OPENCODE_BIN)"
if [ -z "$OPENCODE_BIN" ]; then OPENCODE_BIN="$(command -v opencode || true)"; fi
[ -n "$OPENCODE_BIN" ] || OPENCODE_BIN="$HOME/.opencode/bin/opencode"

report_llm() { echo "[llm] $*" >&2; }
llm_enabled() { [ "$BCP_LLM_ENABLE" = "1" ]; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_pids() { lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

# Echoes the managed server PID ONLY if: pid file exists, pid alive, and it is
# listening on our port. Stale/foreign => empty + nonzero (do not touch).
managed_pid() {
  local pid=""
  if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null || true)"; fi
  case "$pid" in
    ''|*[!0-9]*) echo ""; return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || { echo ""; return 1; }
  local listener
  for listener in $(port_pids "$BCP_LLM_OPENCODE_PORT"); do
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

start() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping opencode"; return 0; }

  if [ ! -x "$OPENCODE_BIN" ] && ! command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
    report_llm "opencode binary not found ($OPENCODE_BIN)"
    report_llm "  fix: install from https://opencode.ai, or set BCP_LLM_OPENCODE_BIN"
    return 1
  fi

  if port_busy "$BCP_LLM_OPENCODE_PORT"; then
    local mpid
    if mpid="$(managed_pid)"; then
      report_llm "opencode already running (pid $mpid) on port $BCP_LLM_OPENCODE_PORT"
      return 0
    fi
    report_llm "port $BCP_LLM_OPENCODE_PORT is held by a FOREIGN process — not ours to manage"
    report_llm "  set BCP_LLM_OPENCODE_PORT to a free port, or stop that opencode yourself"
    return 1
  fi

  mkdir -p "$FAKE_HOME" "$WORK_DIR"
  # The agent definition is what REPLACES opencode's own framing. Without it the
  # request's `system` field is merely added alongside opencode's built-in agent
  # prompt rather than instead of it, and the built-in wins: measured on a 252KB
  # prompt, the answer came back "我是 opencode，专注于帮助软件工程工作" — the
  # exact failure the preamble exists to prevent. The same request with this
  # config answers normally.
  #
  # Copied on every start (not linked) so edits to the bundled files take effect
  # on restart, and so the server's cwd stays a directory we fully own.
  cp "$BUNDLED_DIR/opencode.json" "$WORK_DIR/opencode.json"
  cp "$BUNDLED_DIR/system.md" "$WORK_DIR/system.md"
  report_llm "starting managed opencode serve on 127.0.0.1:$BCP_LLM_OPENCODE_PORT — logs -> $LOG_FILE"
  # `cd` and the three isolation vars together are what keep this server from
  # being the developer's own. See the header for why each one matters.
  (
    cd "$WORK_DIR"
    HOME="$FAKE_HOME" \
    XDG_CONFIG_HOME="$FAKE_HOME/.config" \
    XDG_DATA_HOME="$FAKE_HOME/.local/share" \
    XDG_CACHE_HOME="$FAKE_HOME/.cache" \
      nohup "$OPENCODE_BIN" serve \
        --hostname 127.0.0.1 \
        --port "$BCP_LLM_OPENCODE_PORT" >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )
  for _ in $(seq 1 300); do port_busy "$BCP_LLM_OPENCODE_PORT" && break; sleep 0.1; done
  if ! port_busy "$BCP_LLM_OPENCODE_PORT"; then
    report_llm "opencode failed to start on port $BCP_LLM_OPENCODE_PORT — see $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
  report_llm "opencode listening on 127.0.0.1:$BCP_LLM_OPENCODE_PORT (pid $(cat "$PID_FILE"))"
  return 0
}

stop() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping opencode"; return 0; }
  local pid=""
  if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null || true)"; fi

  local alive=""
  if [ -n "$pid" ]; then alive="$(managed_pid || true)"; fi
  if [ -n "$alive" ]; then
    report_llm "stopping managed opencode (pid $alive)"
    kill -TERM "$alive" 2>/dev/null || true
    if ! port_busy_wait_free "$BCP_LLM_OPENCODE_PORT"; then
      report_llm "  SIGTERM did not free port — SIGKILL"
      kill -KILL "$alive" 2>/dev/null || true
    fi
  elif [ -n "$pid" ]; then
    report_llm ".opencode.pid ($pid) is stale or not on port $BCP_LLM_OPENCODE_PORT — skipping (no kill)"
  fi

  if port_busy "$BCP_LLM_OPENCODE_PORT"; then
    report_llm "warning: port $BCP_LLM_OPENCODE_PORT still held by an unmanaged opencode — leaving untouched"
  else
    report_llm "opencode stopped"
  fi
  rm -f "$PID_FILE"
}

status() {
  if port_busy "$BCP_LLM_OPENCODE_PORT"; then
    echo "opencode:  $BCP_LLM_OPENCODE_PORT (up, managed pid: $(managed_pid || echo none))"
  else
    echo "opencode:  $BCP_LLM_OPENCODE_PORT (down)"
  fi
  echo "  bin:     $OPENCODE_BIN"
  echo "  HOME:    $FAKE_HOME"
  echo "  workdir: $WORK_DIR"
}

case "${1:-}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 1 ;;
esac
