#!/usr/bin/env bash
#
# Start / kill the whole ultrago backend stack:
#   1. @bcp/backend  — Node process: extension WS (BCP_PORT) + MCP HTTP (BCP_MCP_PORT)
#   2. weclaw        — WeChat sidecar daemon (WECLAW_API_ADDR), spawned by the backend
#
# The backend spawns weclaw itself, so `start` brings both up. weclaw daemonizes
# (its launcher forks a background daemon and exits), so an ungracefully-killed
# backend would ORPHAN the weclaw daemon — that's why `kill` stops the backend
# gracefully first (its SIGTERM handler stops weclaw), then sweeps ports and
# runs `weclaw stop` as belt-and-suspenders for an orphaned daemon.
#
# Usage: scripts/backend.sh {start|kill}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.backend.pid"   # launcher pid (liveness marker); kill is port-based, not pid-based
LOG_FILE="$ROOT/.backend.log"
WECLAW_BIN="$ROOT/packages/weclaw/bin/weclaw"
WECLAW_BUILD_SCRIPT="$ROOT/packages/weclaw/build-external-delivery.sh"
WECLAW_BUILD_COMMIT="10711d0c6b7e2b0a784f808ef2f07ba83c2b9023-external-errors-v2"
WECLAW_BUILD_STAMP="$ROOT/packages/weclaw/bin/.external-delivery-commit"

# The external-delivery binary is compiled from source (upstream weclaw + our
# patch), so `pnpm start` needs a Go toolchain matching upstream go.mod (>= 1.25).
# install:bin's prebuilt download is upstream-only and lacks external_delivery.
require_go_1_25() {
  if ! command -v go >/dev/null 2>&1; then
    echo "[stack] Go toolchain not found — the WeClaw external-delivery binary is built from source." >&2
    echo "[stack]   fix: install Go 1.25+ (https://go.dev/dl/) and re-run, or set BCP_WECLAW_DISABLE=1 to skip WeClaw." >&2
    return 1
  fi
  local raw num major minor
  raw="$(go version 2>/dev/null | awk '{print $3}' || true)"   # e.g. "go1.26.5"
  num="${raw#go}"
  major="${num%%.*}"; major="${major//[!0-9]/}"; major="${major:-0}"
  minor="${num#*.}"; minor="${minor%%.*}"; minor="${minor//[!0-9]/}"; minor="${minor:-0}"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 25 ]; }; then
    echo "[stack] Go 1.25+ is required to build the WeClaw external-delivery binary (found ${raw:-unknown})." >&2
    echo "[stack]   fix: upgrade Go (https://go.dev/dl/) and re-run, or set BCP_WECLAW_DISABLE=1 to skip WeClaw." >&2
    return 1
  fi
  return 0
}

ensure_weclaw_binary() {
  if [ "${BCP_WECLAW_DISABLE:-0}" = "1" ]; then
    return 0
  fi
  if [ -x "$WECLAW_BIN" ] && [ -f "$WECLAW_BUILD_STAMP" ] && [ "$(tr -d '[:space:]' < "$WECLAW_BUILD_STAMP")" = "$WECLAW_BUILD_COMMIT" ]; then
    return 0
  fi
  if [ ! -x "$WECLAW_BUILD_SCRIPT" ]; then
    echo "[stack] WeClaw binary is missing or stale, and build script is unavailable" >&2
    return 1
  fi
  if ! require_go_1_25; then
    return 1
  fi
  echo "[stack] building WeClaw external-delivery binary"
  "$WECLAW_BUILD_SCRIPT"
}

require_lsof() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "[stack] lsof is required for lifecycle ownership and port cleanup" >&2
    return 1
  fi
}

# Read a value with process environment taking precedence over .env.
env_val() {
  local name="$1"
  local runtime="${!name:-}"
  if [ -n "$runtime" ]; then
    printf '%s' "$runtime"
  else
    { sed -n "s/^$name=//p" "$ROOT/.env" 2>/dev/null || true; } | tail -1 | tr -d ' \r'
  fi
}
BCP_PORT="$(env_val BCP_PORT)";         BCP_PORT="${BCP_PORT:-8787}"
BCP_MCP_PORT="$(env_val BCP_MCP_PORT)"; BCP_MCP_PORT="${BCP_MCP_PORT:-8788}"
export BCP_PORT BCP_MCP_PORT
CONSOLE_PORT="$(env_val CONSOLE_PORT)"; CONSOLE_PORT="${CONSOLE_PORT:-8790}"
export CONSOLE_PORT
WECLAW_ADDR="$(env_val WECLAW_API_ADDR)"; WECLAW_ADDR="${WECLAW_ADDR:-127.0.0.1:18011}"
WECLAW_PORT="${WECLAW_ADDR##*:}"
export WECLAW_API_ADDR="$WECLAW_ADDR"
BCP_WECLAW_DISABLE="$(env_val BCP_WECLAW_DISABLE)"
# One normalization point, same spellings as the backend's envFlag (on/1/true/yes, any case): every check below
# compares with "1", and the backend reads the exported value — a "true" accepted there but not here split them.
case "$(printf '%s' "${BCP_WECLAW_DISABLE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  on|1|true|yes) BCP_WECLAW_DISABLE=1 ;;
  *) BCP_WECLAW_DISABLE=0 ;;
esac
export BCP_WECLAW_DISABLE
WECLAW_CONFIG_DIR="$(env_val WECLAW_CONFIG_DIR)"
if [ -n "$WECLAW_CONFIG_DIR" ]; then export WECLAW_CONFIG_DIR; fi
BCP_TOKEN="$(env_val BCP_TOKEN)"; export BCP_TOKEN

# Local LLM (@bcp/llm) settings — the provider-aware dispatcher starts with the
# stack and stops with it. Export the provider configuration so child processes
# (backend, console) resolve the same effective provider as the shell.
LLM_ENABLE="$(env_val BCP_LLM_ENABLE)"; LLM_ENABLE="${LLM_ENABLE:-1}"
BCP_LLM_PORT="$(env_val BCP_LLM_PORT)"; BCP_LLM_PORT="${BCP_LLM_PORT:-11435}"
BCP_LLM_PROVIDER="$(env_val BCP_LLM_PROVIDER)"; BCP_LLM_PROVIDER="${BCP_LLM_PROVIDER:-auto}"
BCP_LLM_MODEL="$(env_val BCP_LLM_MODEL)"; BCP_LLM_MODEL="${BCP_LLM_MODEL:-qwen3.5:4b}"
BCP_LLM_OLLAMA_PORT="$(env_val BCP_LLM_OLLAMA_PORT)"; BCP_LLM_OLLAMA_PORT="${BCP_LLM_OLLAMA_PORT:-11437}"
BCP_LLM_NUM_CTX="$(env_val BCP_LLM_NUM_CTX)"; BCP_LLM_NUM_CTX="${BCP_LLM_NUM_CTX:-32768}"
BCP_LLM_LMSTUDIO_MODEL_KEY="$(env_val BCP_LLM_LMSTUDIO_MODEL_KEY)"
BCP_LLM_LMSTUDIO_MODEL_ID="$(env_val BCP_LLM_LMSTUDIO_MODEL_ID)"
BCP_LLM_LMSTUDIO_PORT="$(env_val BCP_LLM_LMSTUDIO_PORT)"
BCP_LLM_LMSTUDIO_CONTEXT_LENGTH="$(env_val BCP_LLM_LMSTUDIO_CONTEXT_LENGTH)"
BCP_LLM_LMSTUDIO_GPU="$(env_val BCP_LLM_LMSTUDIO_GPU)"
BCP_LLM_LMSTUDIO_BIND="$(env_val BCP_LLM_LMSTUDIO_BIND)"
BCP_LLM_LMSTUDIO_BIN="$(env_val BCP_LLM_LMSTUDIO_BIN)"
export BCP_LLM_ENABLE BCP_LLM_PORT BCP_LLM_PROVIDER BCP_LLM_MODEL BCP_LLM_NUM_CTX BCP_LLM_OLLAMA_PORT \
  BCP_LLM_LMSTUDIO_MODEL_KEY BCP_LLM_LMSTUDIO_MODEL_ID BCP_LLM_LMSTUDIO_PORT BCP_LLM_LMSTUDIO_CONTEXT_LENGTH \
  BCP_LLM_LMSTUDIO_GPU BCP_LLM_LMSTUDIO_BIND BCP_LLM_LMSTUDIO_BIN

port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}         # true if any process holds the port
port_pids() {
  lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}
process_cwd() {
  local pid="$1"
  local line
  local cwd=""
  if ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi
  while IFS= read -r line; do
    case "$line" in
      n*) cwd="${line#n}"; break ;;
    esac
  done < <(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null || true)
  [ -n "$cwd" ] && printf '%s' "$cwd"
}
process_cwd_is_root() {
  [ "$(process_cwd "$1")" = "$ROOT" ]
}
process_is_root_owned() {
  local pid="$1"
  local launcher_marker="${2:-}"
  process_cwd_is_root "$pid" && return 0
  case "$launcher_marker:$(process_cwd "$pid")" in
    "@bcp/backend:$ROOT/packages/backend")
      return 0
      ;;
  esac
  [ -n "$launcher_marker" ] || return 1

  local parent
  local command
  while :; do
    parent="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]')"
    case "$parent" in
      ''|*[!0-9]*|1) return 1 ;;
    esac
    if process_cwd_is_root "$parent"; then
      command="$(ps -p "$parent" -o command= 2>/dev/null || true)"
      case "$command" in
        *"pnpm --filter $launcher_marker start"*|*"pnpm --filter $launcher_marker run start"*)
          return 0
          ;;
      esac
    fi
    pid="$parent"
  done
}
is_backend_process() {
  local pid="$1"
  local command
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"pnpm --filter @bcp/backend start"*|\
    *"pnpm --filter @bcp/backend run start"*|\
      *"$ROOT/packages/backend/src/index.ts"*|\
      *"$ROOT/packages/backend/dist/index.js"*|\
     *"tsx packages/backend/src/index.ts"*|\
      *"tsx src/index.ts"*|\
      *"node packages/backend/dist/index.js"*|\
      *"node dist/index.js"*|\
    *"tsx/dist/cli.mjs src/index.ts"*|\
     *"loader.mjs packages/backend/src/index.ts"|\
     *"loader.mjs src/index.ts"*)
      process_is_root_owned "$pid" "@bcp/backend" || return 1
      return 0
      ;;
  esac
  return 1
}
# Verify a PID really is THIS repo's console before signalling it.
#
# `.console.pid` goes stale easily — a crash, a manual restart, anything that
# brings the console up outside start(). The OS recycles PIDs, so an unverified
# kill on a stale file eventually fires at whatever process inherited the
# number. is_backend_process guards the backend for exactly this reason; the
# console had no equivalent, which is the asymmetry this closes.
#
# An absolute-path invocation is self-identifying ($ROOT is in the command
# line). A relative one ("node packages/console/dist/main.js") is only
# conclusive together with the process's cwd — same tactic as
# is_weclaw_process below.
is_console_process() {
  local pid="$1"
  local command
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"$ROOT/packages/console/dist/main.js"*) return 0 ;;
  esac
  case "$(process_cwd "$pid")" in
    "$ROOT"|"$ROOT/packages/console") ;;
    *) return 1 ;;
  esac
  case "$command" in
    *"packages/console/dist/main.js"*|*"console/dist/main.js"*|*"dist/main.js"*) return 0 ;;
  esac
  return 1
}

is_weclaw_process() {
  local pid="$1"
  local command
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  case "$(process_cwd "$pid")" in
    "$ROOT"|"$ROOT/packages/backend") ;;
    *) return 1 ;;
  esac
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"$WECLAW_BIN"*|*"packages/weclaw/bin/weclaw"*) return 0 ;;
  esac
  return 1
}
pid_is_descendant_of() {
  local child="$1"
  local ancestor="$2"
  local parent
  while :; do
    case "$child" in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "$child" = "$ancestor" ] && return 0
    parent="$(ps -p "$child" -o ppid= 2>/dev/null | tr -d '[:space:]')"
    case "$parent" in
      ''|*[!0-9]*|1) return 1 ;;
    esac
    child="$parent"
  done
}
backend_listener_pid_confirmed() {
  local pid="$1"
  local owner_pid="$2"
  local known_pids="${3:-}"
  if [ -z "$owner_pid" ]; then
    is_backend_process "$pid"
    return $?
  fi
  if is_backend_process "$pid" && is_backend_process "$owner_pid" && {
    [ "$pid" = "$owner_pid" ] || pid_is_descendant_of "$pid" "$owner_pid"
  }; then
    return 0
  fi
  for known_pid in $known_pids; do
    if [ "$pid" = "$known_pid" ] && is_backend_process "$pid"; then
      return 0
    fi
  done
  return 1
}
backend_listener_pids() {
  local owner_pid="$1"
  local known_pids="${2:-}"
  local port
  local pid
  local seen=""
  for port in "$BCP_PORT" "$BCP_MCP_PORT"; do
    for pid in $(port_pids "$port"); do
      case " $seen " in
        *" $pid "*) continue ;;
      esac
      if backend_listener_pid_confirmed "$pid" "$owner_pid" "$known_pids"; then
        printf '%s\n' "$pid"
        seen="$seen $pid"
      fi
    done
  done
}
backend_signal_pids() {
  local signal="$1"
  local pids="$2"
  local owner_pid="$3"
  local known_pids="${4:-}"
  local pid
  for pid in $pids; do
    if backend_listener_pid_confirmed "$pid" "$owner_pid" "$known_pids"; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}
backend_pid_listens() {
  local wanted_pid="$1"
  local port
  for port in "$BCP_PORT" "$BCP_MCP_PORT"; do
    for pid in $(port_pids "$port"); do
      if [ "$pid" = "$wanted_pid" ]; then return 0; fi
    done
  done
  return 1
}
wait_backend_closed() {
  local listener_pids="$1"
  local still_listening
  for _ in $(seq 1 100); do
    still_listening=0
    for pid in $listener_pids; do
      if backend_pid_listens "$pid"; then
        still_listening=1
        break
      fi
    done
    if [ "$still_listening" -eq 0 ]; then return 0; fi
    sleep 0.1
  done
  echo "[stack] timed out waiting for managed backend listeners to close" >&2
  return 1
}
weclaw_listener_pid_confirmed() {
  local pid="$1"
  local known_pids="${2:-}"
  if is_weclaw_process "$pid"; then
    for known_pid in $known_pids; do
      if [ "$pid" = "$known_pid" ]; then return 0; fi
    done
    # The daemon outlives its launcher, so its project binary is the ownership marker.
    return 0
  fi
  return 1
}
weclaw_listener_pids() {
  local known_pids="${1:-}"
  local pid
  for pid in $(port_pids "$WECLAW_PORT"); do
    if weclaw_listener_pid_confirmed "$pid" "$known_pids"; then
      printf '%s\n' "$pid"
    fi
  done
}
weclaw_signal_pids() {
  local signal="$1"
  local pids="$2"
  local known_pids="${3:-}"
  local pid
  for pid in $pids; do
    if weclaw_listener_pid_confirmed "$pid" "$known_pids"; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}
wait_weclaw_closed() {
  local listener_pids="$1"
  for _ in $(seq 1 100); do
    local still_listening=0
    for pid in $listener_pids; do
      for current_pid in $(port_pids "$WECLAW_PORT"); do
        if [ "$pid" = "$current_pid" ]; then
          still_listening=1
          break 2
        fi
      done
    done
    if [ "$still_listening" -eq 0 ]; then return 0; fi
    sleep 0.1
  done
  echo "[stack] timed out waiting for managed WeClaw listeners to close" >&2
  return 1
}
wait_weclaw_ready() {
  if [ "$BCP_WECLAW_DISABLE" = "1" ]; then
    return 0
  fi
  for _ in $(seq 1 100); do
    if [ -n "$(weclaw_listener_pids)" ]; then
      return 0
    fi
    sleep 0.1
  done
  echo "[stack] timed out waiting for managed WeClaw listener on port $WECLAW_PORT" >&2
  return 1
}
wait_port() {
  local port="$1"
  for _ in $(seq 1 100); do
    if port_busy "$port"; then return 0; fi
    sleep 0.1
  done
  echo "[stack] timed out waiting for port $port" >&2
  return 1
}

# WeChat login is an interactive QR scan. The managed sidecar's output goes to
# a log file and wait_weclaw_ready kills the stack on timeout, so login must
# happen HERE in the foreground — before the backend spawns — where the QR can
# render in the user's terminal and the scan isn't raced by any timeout.
ensure_weclaw_login() {
  if [ "$BCP_WECLAW_DISABLE" = "1" ]; then
    return 0
  fi
  (cd "$ROOT" && pnpm --filter @bcp/weclaw run ensure-login)
}

# Post-boot session health check. A saved credential file existing does NOT
# mean the session is alive — the daemon's monitor is the only source of truth,
# and it logs "session expired" within a few seconds of boot when the token is
# dead. check-session (foreground) polls the log and exits 2 when expired; we
# then tear the stack down FIRST (so no half-dead daemon holds the old token
# while we scan), run the interactive QR login, and restart the stack.
ensure_weclaw_session() {
  if [ "$BCP_WECLAW_DISABLE" = "1" ]; then
    return 0
  fi
  local rc=0
  (cd "$ROOT" && pnpm --filter @bcp/weclaw run check-session) || rc=$?
  case "$rc" in
    0) return 0 ;;
    2)
      if [ "${WECLAW_SESSION_RETRY:-0}" = "1" ]; then
        echo "[stack] WeChat session still unhealthy after re-login — giving up" >&2
        kill_all
        exit 1
      fi
      echo "[stack] WeChat session expired — stopping the stack to re-login"
      kill_all
      if ! (cd "$ROOT" && pnpm --filter @bcp/weclaw run ensure-login --force); then
        echo "[stack] re-login failed or cancelled — stack is stopped, nothing is running" >&2
        exit 1
      fi
      echo "[stack] re-login done, restarting the stack"
      export WECLAW_SESSION_RETRY=1
      start
      ;;
    *)
      echo "[stack] WeChat session check failed (rc=$rc)" >&2
      kill_all
      exit 1
      ;;
  esac
}

ensure_console_db() {
  # The console boots NestJS + Prisma against a SQLite file. Prisma opens that
  # file lazily, so a missing database does NOT fail at boot — it surfaces much
  # later as `Unable to open the database file` from inside a request handler,
  # by which point the stack looks healthy and the real cause (never ran
  # `pnpm run init`) is several layers away. Fail fast here instead.
  #
  # Check only, never create. Provisioning a database is a deliberate step —
  # scripts/init.sh does it via `prisma migrate deploy` — not something a start
  # command should do behind the operator's back.
  #
  # Skipped when DATABASE_URL is set: that caller owns provisioning, and the
  # URL isn't necessarily a local file path we could stat.
  if [ -n "${DATABASE_URL:-}" ]; then return 0; fi
  local db="$ROOT/resource/db/console.db"
  if [ -f "$db" ]; then return 0; fi
  # A checkout from before the resource/ consolidation still holds the DB (and
  # staged uploads) at the old, UNTRACKED locations — git moved neither. Saying
  # "run pnpm run init" here would be actively harmful: init.sh would `db push` a
  # fresh empty database, filesync would refill Book rows from the tracked
  # playbooks, and the console would come up looking healthy with every run,
  # schedule and artifact apparently gone. Detect that case and refuse instead.
  if [ -f "$ROOT/packages/console/data/console.db" ]; then
    echo "[stack] found a pre-resource/ database at packages/console/data/console.db" >&2
    echo "[stack] do NOT run \`pnpm run init\` — it would create an empty DB and your run history would look lost." >&2
    echo "[stack] move it instead:" >&2
    echo "[stack]   mkdir -p $ROOT/resource/db && mv $ROOT/packages/console/data/console.db* $ROOT/resource/db/" >&2
    [ -d "$ROOT/uploads" ] && echo "[stack]   mv $ROOT/uploads $ROOT/resource/uploads" >&2
    exit 1
  fi
  echo "[stack] console database missing: $db" >&2
  echo "[stack] run \`pnpm run init\` first — it creates the schema via prisma migrate deploy" >&2
  echo "[stack]   (\`pnpm run init\`, not \`pnpm init\` — the latter is pnpm's own built-in and only makes a package.json)" >&2
  exit 1
}

ensure_build_artifacts() {
  # Same reasoning as ensure_console_db, for the other class of missing input.
  # Both processes below are launched with `nohup … >logfile &`, and this
  # function then only waits on a TCP port — so a process that dies during
  # module loading is reported as `console failed to start on port 8790` ten
  # seconds later, blaming the port for a missing file. `dist/` is gitignored,
  # so a fresh clone has none of this until `pnpm build` runs.
  #
  # These have to be checked from the shell, not from inside the app: the
  # failures are ESM link-time, raised while Node resolves the import graph and
  # before any line of our code executes. Nothing in main.ts can catch them.
  #
  # The generated Prisma client is deliberately NOT checked here. It lives at a
  # version-pinned path inside the pnpm store, which a shell guard would have to
  # hardcode and would silently stop matching on the next Prisma bump — a guard
  # that quietly tests nothing is worse than no guard. It is produced by the
  # same `pnpm build` these artifacts are, so the check below already covers the
  # case that actually happens (never built).
  # An array, iterated quoted. A plain string would be IFS-split AND globbed, so
  # a ROOT containing a space or a `[` would fragment every path, fail every
  # `-f`, and abort the start with a fabricated "build output missing".
  #
  # weclaw/dist is required even under BCP_WECLAW_DISABLE=1. That flag skips
  # the SIDECAR — compiling and launching the Go binary — but `@bcp/weclaw` is a
  # STATIC import in packages/backend/src/index.ts, packages/backend/src/
  # mcp-http.ts and packages/console/src/runs/delivery-executor.ts, so the
  # module is linked no matter what the flag says. Skipping the check there
  # would have left `pnpm start:no-weclaw` on an unbuilt tree dying at link time
  # with the misleading port timeout this whole function exists to prevent.
  local -a required=(
    "$ROOT/packages/shared/dist/index.js"
    "$ROOT/packages/weclaw/dist/index.js"
    "$ROOT/packages/backend/dist/index.js"
    "$ROOT/packages/console/dist/main.js"
  )
  local missing="" f
  for f in "${required[@]}"; do
    [ -f "$f" ] || missing="$missing  $f
"
  done
  if [ -n "$missing" ]; then
    echo "[stack] build output missing — the stack cannot start:" >&2
    printf '%s' "$missing" >&2
    echo "[stack]   fix: pnpm build   (dist/ is gitignored, so a fresh clone never has it)" >&2
    exit 1
  fi
  # Non-fatal on purpose: without it the API serves normally and only the UI
  # 404s, so refusing to start would be a worse outcome than saying so.
  if [ ! -f "$ROOT/packages/console/dist-web/index.html" ]; then
    echo "[stack] warning: packages/console/dist-web is missing — the API will run but the web UI will 404" >&2
    echo "[stack]   fix: pnpm --filter @bcp/console run build:web" >&2
  fi
}

start() {
  trap 'kill_all' INT TERM
  bash "$ROOT/scripts/python.sh" -c 'pass' || return 1
  ensure_console_db
  ensure_build_artifacts
  ensure_weclaw_binary
  ensure_weclaw_login
  # Idempotent start: if any of the stack ports is held, assume it's a
  # previous run that wasn't cleaned up and stop it first. Without this,
  # a second `pnpm start` would `exit 1` and force the user to `pnpm kill`
  # manually. Foreign (non-project) listeners on these ports are still
  # refused — see the per-port checks below for that.
  if port_busy "$BCP_PORT" || port_busy "$BCP_MCP_PORT" || port_busy "$CONSOLE_PORT"; then
    echo "[stack] existing stack detected on $BCP_PORT/$BCP_MCP_PORT/$CONSOLE_PORT — recycling"
    kill_all
  fi
  if [ "$BCP_WECLAW_DISABLE" != "1" ] && port_busy "$WECLAW_PORT"; then
    if [ -n "$(weclaw_listener_pids)" ]; then
      echo "[stack] cleaning stale project WeClaw listener on port $WECLAW_PORT" >&2
      stop_managed_weclaw
    fi
    if port_busy "$WECLAW_PORT"; then
      echo "[stack] WeClaw port $WECLAW_PORT is already in use by a foreign process — not ours to kill" >&2
      exit 1
    fi
  fi
  cd "$ROOT"
  echo "[stack] starting backend + weclaw sidecar — logs -> $LOG_FILE"
  nohup pnpm --filter @bcp/backend start >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  if ! wait_port "$BCP_MCP_PORT"; then kill_all; exit 1; fi
  if ! wait_weclaw_ready; then kill_all; exit 1; fi
  ensure_weclaw_session

  # Start the console (RPA management dashboard) on a separate log file.
  local console_log="$ROOT/.console.log"
  echo "[stack] starting console — logs -> $console_log"
  CONSOLE_PORT="$CONSOLE_PORT" \
    DATABASE_URL="${DATABASE_URL:-file:${ROOT}/resource/db/console.db}" \
    BCP_INTERNAL_URL="${BCP_INTERNAL_URL:-http://127.0.0.1:8789}" \
    nohup node "$ROOT/packages/console/dist/main.js" >"$console_log" 2>&1 &
  local console_pid=$!
  echo "$console_pid" >"$ROOT/.console.pid"
  if ! wait_port "$CONSOLE_PORT"; then
    echo "[stack] console failed to start on port $CONSOLE_PORT" >&2
    kill_all
    exit 1
  fi
  start_llm

  echo "[stack] launched; backend logs: $LOG_FILE"
  echo "[stack] console: http://127.0.0.1:$CONSOLE_PORT"
}

stop_managed_weclaw() {
  # WeClaw daemonizes and may outlive the backend launcher. Its project binary
  # command line is the ownership marker; foreign port holders are warnings only.
  local weclaw_listener_snapshot=""
  if port_busy "$WECLAW_PORT"; then
    weclaw_listener_snapshot="$(weclaw_listener_pids)"
    if [ -n "$weclaw_listener_snapshot" ] && [ -x "$WECLAW_BIN" ]; then
      echo "[stack] weclaw stop (confirmed project listener)"
      "$WECLAW_BIN" stop >/dev/null 2>&1 || true
    fi
    if [ -n "$weclaw_listener_snapshot" ]; then
      weclaw_listener_snapshot="$(weclaw_listener_pids "$weclaw_listener_snapshot")"
      if [ -n "$weclaw_listener_snapshot" ]; then
        echo "[stack] SIGTERM confirmed WeClaw listeners (port $WECLAW_PORT)"
        weclaw_signal_pids TERM "$weclaw_listener_snapshot" "$weclaw_listener_snapshot"
        wait_weclaw_closed "$weclaw_listener_snapshot" || true
        weclaw_listener_snapshot="$(weclaw_listener_pids "$weclaw_listener_snapshot")"
        if [ -n "$weclaw_listener_snapshot" ]; then
          echo "[stack] SIGKILL confirmed WeClaw listeners"
          weclaw_signal_pids KILL "$weclaw_listener_snapshot" "$weclaw_listener_snapshot"
        fi
      fi
    fi
    if port_busy "$WECLAW_PORT"; then
      echo "[stack] warning: port $WECLAW_PORT is occupied by an unmanaged WeClaw listener; leaving it untouched" >&2
    fi
  fi
}

kill_all() {
  local backend_owner_pid=""
  local backend_listener_snapshot=""
  local console_pid=""

  # Read PID files upfront (may be stale).
  if [ -f "$PID_FILE" ]; then
    backend_owner_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if [ -f "$ROOT/.console.pid" ]; then
    console_pid="$(cat "$ROOT/.console.pid" 2>/dev/null || true)"
  fi

  # 1) Kill the backend. Try PID-based approach first; if the PID is stale
  #    (e.g. process restarted without ./backend.pid being cleaned), fall
  #    back to port-based lsof hunting.
  if [ -n "$backend_owner_pid" ] && ! is_backend_process "$backend_owner_pid"; then
    # Stale PID — fall back to killing whatever is on the backend ports.
    if port_busy "$BCP_PORT" || port_busy "$BCP_MCP_PORT"; then
      echo "[stack] stale backend PID — killing port listeners ($BCP_PORT/$BCP_MCP_PORT)"
      for port in "$BCP_PORT" "$BCP_MCP_PORT"; do
        local pids
        pids="$(port_pids "$port")"
        if [ -n "$pids" ]; then
          echo "$pids" | xargs kill -TERM 2>/dev/null || true
          sleep 0.5
          pids="$(port_pids "$port")"
          if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -KILL 2>/dev/null || true
          fi
        fi
      done
    fi
  elif port_busy "$BCP_PORT" || port_busy "$BCP_MCP_PORT"; then
    backend_listener_snapshot="$(backend_listener_pids "$backend_owner_pid")"
    if [ -n "$backend_listener_snapshot" ]; then
      echo "[stack] SIGTERM confirmed backend listeners ($BCP_PORT/$BCP_MCP_PORT)"
      backend_signal_pids TERM "$backend_listener_snapshot" "$backend_owner_pid" "$backend_listener_snapshot"
      wait_backend_closed "$backend_listener_snapshot" || true
      backend_listener_snapshot="$(backend_listener_pids "$backend_owner_pid" "$backend_listener_snapshot")"
      if [ -n "$backend_listener_snapshot" ]; then
        echo "[stack] SIGKILL confirmed backend listeners"
        backend_signal_pids KILL "$backend_listener_snapshot" "$backend_owner_pid" "$backend_listener_snapshot"
      fi
    fi
    if port_busy "$BCP_PORT" || port_busy "$BCP_MCP_PORT"; then
      # Fallback: lsof-based kill for unconfirmed listeners.
      echo "[stack] force-killing unconfirmed listeners on $BCP_PORT/$BCP_MCP_PORT"
      for port in "$BCP_PORT" "$BCP_MCP_PORT"; do
        local pids
        pids="$(port_pids "$port")"
        if [ -n "$pids" ]; then
          echo "$pids" | xargs kill -KILL 2>/dev/null || true
        fi
      done
    fi
  fi
  rm -f "$PID_FILE"

  # 2) Kill the console. PID-based first (only if the PID is confirmed to BE
  #    the console — see is_console_process), then port fallback. An
  #    unconfirmed PID is skipped rather than signalled: a stale .console.pid
  #    whose number the OS has since handed to something else would otherwise
  #    get that innocent process SIGKILLed. The port sweep below still cleans
  #    up whatever actually holds CONSOLE_PORT, so skipping costs nothing.
  if [ -n "$console_pid" ] && is_console_process "$console_pid"; then
    kill -TERM "$console_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$console_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$console_pid" 2>/dev/null || true
  elif [ -n "$console_pid" ]; then
    echo "[stack] .console.pid ($console_pid) is stale or not this repo's console — skipping PID kill"
  fi
  if port_busy "$CONSOLE_PORT"; then
    echo "[stack] force-killing console listener on $CONSOLE_PORT"
    local pids
    pids="$(port_pids "$CONSOLE_PORT")"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill -KILL 2>/dev/null || true
    fi
  fi
  rm -f "$ROOT/.console.pid"

  # 3) WeClaw daemonizes and may outlive the backend launcher.
  stop_managed_weclaw

  # 4) LLM gateway + its local backend, managed by @bcp/llm.
  stop_llm

  echo "[stack] done — managed services stopped"
}

start_llm() {
  if [ "$LLM_ENABLE" != "1" ]; then
    echo "[stack] local LLM disabled (BCP_LLM_ENABLE=0) - skipping"
    return 0
  fi
  echo "[stack] starting LLM gateway (provider=$BCP_LLM_PROVIDER) - OpenAI API on port $BCP_LLM_PORT"
  (cd "$ROOT" && pnpm --filter @bcp/llm start)
}

stop_llm() {
  if [ "$LLM_ENABLE" != "1" ]; then return 0; fi
  (cd "$ROOT" && pnpm --filter @bcp/llm stop)
}

dev() {
  cd "$ROOT"
  trap 'kill_all' EXIT INT TERM
  echo "[stack] dev mode disables WeClaw; use pnpm start for the full WeChat stack"
  BCP_WECLAW_DISABLE=1 pnpm --filter @bcp/backend dev
}

case "${1:-}" in
  start)     require_lsof; start ;;
  kill|stop) require_lsof; kill_all ;;
  dev)       dev ;;
  *) echo "usage: $0 {start|kill|dev}" >&2; exit 1 ;;
esac
