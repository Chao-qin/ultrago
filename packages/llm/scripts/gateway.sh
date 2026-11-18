#!/usr/bin/env bash
#
# @bcp/llm — the OpenAI-protocol gateway process.
#
# Owns BCP_LLM_PORT (11435) for BOTH profiles. The local runtime — managed
# Ollama or LM Studio — sits behind it on its own internal port and is never
# reached directly by callers. That is the whole reason this script exists
# separately from ollama.sh / lmstudio.sh: the public port belongs to the
# gateway now, not to whichever backend happens to be running.
#
# Ownership rules are the ones lmstudio.sh's proxy already got right and this
# inherits verbatim: a PID file, a check that the recorded PID is REALLY the
# listener on that port, and a hard refusal to touch a port held by anything we
# did not start.
#
#   start   build if needed, then listen on BCP_LLM_PORT
#   stop    stop only our own process
#   status  one line of truth
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BCP_LLM_STATE_DIR:-$SCRIPT_DIR}"
LOG_FILE="$STATE_DIR/.llm.log"
PID_FILE="$STATE_DIR/.llm-gateway.pid"
GATEWAY_SCRIPT="$SCRIPT_DIR/../dist/gateway.js"

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
BCP_LLM_PORT="$(env_val BCP_LLM_PORT)";     BCP_LLM_PORT="${BCP_LLM_PORT:-11435}"
PUBLIC_API="http://127.0.0.1:$BCP_LLM_PORT"

report_llm() { echo "[llm] $*" >&2; }
llm_enabled() { [ "$BCP_LLM_ENABLE" = "1" ]; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# A recorded PID that is alive proves nothing on its own — PIDs get recycled.
# It counts as ours only if it is the process actually listening on our port.
gateway_pid() {
  local pid=""
  if [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE" 2>/dev/null || true)"; fi
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  local listener
  for listener in $(lsof -t -nP -iTCP:"$BCP_LLM_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    if [ "$listener" = "$pid" ]; then printf '%s' "$pid"; return 0; fi
  done
  return 1
}

ensure_built() {
  if [ -f "$GATEWAY_SCRIPT" ]; then return 0; fi
  report_llm "gateway is not built — building @bcp/llm"
  pnpm --dir "$SCRIPT_DIR/.." build >>"$LOG_FILE" 2>&1 || return 1
  [ -f "$GATEWAY_SCRIPT" ] || { report_llm "build did not produce $GATEWAY_SCRIPT"; return 1; }
}

start() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping gateway"; return 0; }
  if port_busy "$BCP_LLM_PORT"; then
    local pid
    if pid="$(gateway_pid)"; then
      report_llm "reusing project gateway on $PUBLIC_API (pid $pid)"
      return 0
    fi
    report_llm "public LLM port $BCP_LLM_PORT is held by a FOREIGN process — not ours to manage"
    report_llm "  free it or set BCP_LLM_PORT elsewhere"
    return 1
  fi
  ensure_built || return 1
  report_llm "starting OpenAI gateway on $PUBLIC_API"
  nohup node "$GATEWAY_SCRIPT" --port "$BCP_LLM_PORT" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 100); do port_busy "$BCP_LLM_PORT" && break; sleep 0.1; done
  if ! gateway_pid >/dev/null; then
    report_llm "gateway did not come up on $BCP_LLM_PORT — see $LOG_FILE"
    # We spawned it, so it is ours to clean up even though it never became the
    # listener. Dropping the pid file first would orphan it permanently — and
    # the next start would then see its port as FOREIGN and refuse forever.
    local spawned
    spawned="$(cat "$PID_FILE" 2>/dev/null || true)"
    case "$spawned" in
      ''|*[!0-9]*) ;;
      *) kill -TERM "$spawned" 2>/dev/null || true ;;
    esac
    rm -f "$PID_FILE"
    return 1
  fi
}

stop() {
  local pid
  if pid="$(gateway_pid)"; then
    report_llm "stopping project gateway (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do ! port_busy "$BCP_LLM_PORT" && break; sleep 0.1; done
    if port_busy "$BCP_LLM_PORT"; then
      report_llm "warning: port $BCP_LLM_PORT still busy after TERM — leaving it untouched"
    fi
  elif port_busy "$BCP_LLM_PORT"; then
    report_llm "warning: public LLM port $BCP_LLM_PORT is foreign — leaving it untouched"
  fi
  rm -f "$PID_FILE"
}

status() {
  local pid
  if pid="$(gateway_pid)"; then
    echo "gateway:   $PUBLIC_API (up, pid $pid)"
    curl -fsS --max-time 5 "$PUBLIC_API/v1/models" 2>/dev/null | head -c 400 || true
    echo
  elif port_busy "$BCP_LLM_PORT"; then
    echo "gateway:   $PUBLIC_API (port busy, FOREIGN)"
  else
    echo "gateway:   $PUBLIC_API (down)"
  fi
}

case "${1:-}" in
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
