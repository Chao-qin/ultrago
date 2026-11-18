#!/usr/bin/env bash
#
# @bcp/llm — provider-aware local LLM lifecycle dispatcher.
#
# Decides which local inference runtime this machine should use (LM Studio on a
# Mac Apple Silicon 16 GiB profile, managed Ollama everywhere else) and forwards
# every lifecycle command to the matching manager. Business callers never see
# the provider split — they read `.llm-runtime.json` (or env + legacy defaults).
#
# Commands:
#   start    ensure the runtime for the resolved profile is up and verified
#   stop     stop ONLY what this project started (never a foreign listener)
#   status   profile + provider + port + model + ownership + first failure
#   pull     download the profile's target model (never deletes)
#   setup    idempotent: download + load + health-check + write snapshot
#   migrate  [DESTRUCTIVE] setup the new model, then delete ONLY qwen3.5:4b
#            from the explicit old Ollama endpoint. Requires
#            BCP_LLM_MIGRATE_CONFIRM=yes, BCP_LLM_MIGRATE_LIVE_ACCEPTED=yes,
#            and a passing preflight gate.
#   ensure   prerequisites only (used by scripts/init.sh)
#
# Provider selection precedence (spec §6.1): process env > .env > defaults.
#   BCP_LLM_PROVIDER=auto      → hardware profile decides (default)
#   BCP_LLM_PROVIDER=ollama    → managed Ollama + qwen3.5:4b (explicit legacy)
#   BCP_LLM_PROVIDER=lmstudio  → LM Studio + Qwen3.5-9B GGUF (explicit)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime state lives in the package dir by default; BCP_LLM_STATE_DIR lets the
# lifecycle regression tests redirect it to a temp dir (production unchanged).
STATE_DIR="${BCP_LLM_STATE_DIR:-$SCRIPT_DIR}"

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
BCP_LLM_MODEL="$(env_val BCP_LLM_MODEL)";   BCP_LLM_MODEL="${BCP_LLM_MODEL:-qwen3.5:4b}"
# The backend's own port. BCP_LLM_PORT belongs to the gateway; every local
# runtime sits behind it and is reached only by the ollama / lmstudio adapter.
BCP_LLM_OLLAMA_PORT="$(env_val BCP_LLM_OLLAMA_PORT)"; BCP_LLM_OLLAMA_PORT="${BCP_LLM_OLLAMA_PORT:-11437}"

report_llm() { echo "[llm] $*" >&2; }

llm_enabled() { [ "$BCP_LLM_ENABLE" = "1" ]; }

# ---------------------------------------------------------------------------
# Profile / provider resolution (shell-side mirror of runtime-profile.ts).
# Unknown or insufficient hardware NEVER lands on the Mac profile.
# ---------------------------------------------------------------------------
detect_profile() {
  local override
  override="$(env_val BCP_LLM_PROVIDER)"; override="${override:-auto}"
  case "$override" in
    ollama)
      PROVIDER="ollama"; PROFILE="legacy-local"; PROVIDER_SOURCE="explicit"
      return 0 ;;
    lmstudio)
      PROVIDER="lmstudio"; PROFILE="mac-apple-silicon-16gb"; PROVIDER_SOURCE="explicit"
      return 0 ;;
    auto) ;;
    *)
      report_llm "unknown BCP_LLM_PROVIDER=$override — treating as auto"
      ;;
  esac

  local os arch cpu mem
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  cpu=""
  mem=0
  if [ "$os" = "Darwin" ]; then
    cpu="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    mem="$(sysctl -n hw.memsize 2>/dev/null || 0)"
  fi
  if [ "$os" = "Darwin" ] && [ "$arch" = "arm64" ] && \
     [[ "$cpu" == *Apple* ]] && [ "$mem" -ge 17179869184 ]; then
    PROVIDER="lmstudio"; PROFILE="mac-apple-silicon-16gb"
  else
    PROVIDER="ollama"; PROFILE="legacy-local"
  fi
  PROVIDER_SOURCE="auto"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
dispatch() {
  local cmd="$1"
  case "$PROVIDER" in
    ollama)   "$SCRIPT_DIR/ollama.sh" "$cmd" ;;
    lmstudio) "$SCRIPT_DIR/lmstudio.sh" "$cmd" ;;
  esac
}

start() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  report_llm "profile=$PROFILE provider=$PROVIDER ($PROVIDER_SOURCE)"
  # Backend first, gateway second: the gateway resolves its channel table at
  # boot, and a local channel pointing at a port nobody is listening on yet is
  # a startup race we have no reason to invite.
  dispatch start
  # opencode is NOT a provider profile — ollama/lmstudio are alternatives to each
  # other, opencode is a peer that runs alongside whichever one is active. So it
  # is started unconditionally rather than through dispatch.
  #
  # A failure here must not take the stack down: opencode may simply not be
  # installed, and the other channels are unaffected. The script has already
  # printed why on stderr, and the opencode channel will report itself unhealthy
  # through /health — the same as a down Ollama would.
  "$SCRIPT_DIR/opencode.sh" start || report_llm "opencode channel will be unavailable (see above)"
  "$SCRIPT_DIR/gateway.sh" start
}

stop() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  report_llm "profile=$PROFILE provider=$PROVIDER ($PROVIDER_SOURCE)"
  # Reverse order: stop taking traffic before removing what serves it.
  "$SCRIPT_DIR/gateway.sh" stop
  dispatch stop
  "$SCRIPT_DIR/opencode.sh" stop
}

status() {
  echo "profile:   $PROFILE"
  echo "provider:  $PROVIDER ($PROVIDER_SOURCE)"
  "$SCRIPT_DIR/gateway.sh" status
  dispatch status
  "$SCRIPT_DIR/opencode.sh" status
}

ensure() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  dispatch ensure
}

pull() {
  dispatch pull
}

setup() {
  dispatch setup
}

# Deletion gate for `migrate`: every automated precondition must pass before the
# destructive step. The spec's full gate (spec §11 阶段 4) additionally requires
# the human-run live acceptance (stack start/kill, Python paths, rollback
# readiness) — that is a manual checklist, not something this script can redo.
deletion_gate() {
  local snap="$STATE_DIR/.llm-runtime.json"
  if [ ! -f "$snap" ]; then
    report_llm "gate: no .llm-runtime.json — run \`pnpm run llm:setup\` first"
    return 1
  fi
  if ! grep -q '"provider"[[:space:]]*:[[:space:]]*"lmstudio"' "$snap"; then
    report_llm "gate: snapshot provider is not lmstudio — nothing to migrate"
    return 1
  fi
  local model_id
  model_id="$(env_val BCP_LLM_LMSTUDIO_MODEL_ID)"; model_id="${model_id:-qwen3.5-9b}"
  if ! grep -q "\"model\"[[:space:]]*:[[:space:]]*\"$model_id\"" "$snap"; then
    report_llm "gate: snapshot model is not $model_id — refusing"
    return 1
  fi
  local bin
  bin="$(command -v ollama || true)"
  if [ -z "$bin" ]; then
    report_llm "gate: old Ollama binary not found — nothing to delete against"
    return 1
  fi
  return 0
}

migrate() {
  if [ "$PROVIDER" != "lmstudio" ]; then
    report_llm "migrate targets the LM Studio profile; current provider=$PROVIDER ($PROVIDER_SOURCE)"
    report_llm "  set BCP_LLM_PROVIDER=auto (or lmstudio) after installing LM Studio"
    return 1
  fi
  if [ "${BCP_LLM_MIGRATE_CONFIRM:-}" != "yes" ]; then
    report_llm "REFUSING: \`migrate\` deletes qwen3.5:4b from the project Ollama store."
    report_llm "  Complete the spec §11 live acceptance first, then re-run with"
    report_llm "  BCP_LLM_MIGRATE_CONFIRM=yes. Rollback is impossible without a re-download."
    return 1
  fi
  if [ "${BCP_LLM_MIGRATE_LIVE_ACCEPTED:-}" != "yes" ]; then
    report_llm "REFUSING: the required live acceptance has not been acknowledged."
    report_llm "  Verify text, structured JSON, real WebP detection, Python callers, start/kill,"
    report_llm "  and rollback readiness, then re-run with BCP_LLM_MIGRATE_LIVE_ACCEPTED=yes."
    return 1
  fi

  # 1. Bring the new runtime up (download + load + health + snapshot).
  if ! "$SCRIPT_DIR/lmstudio.sh" setup; then
    report_llm "migrate aborted: LM Studio setup failed"
    return 1
  fi
  # 2. Automated deletion gate.
  if ! deletion_gate; then
    report_llm "migrate aborted: deletion gate not satisfied"
    return 1
  fi
  # 3. Swap the backend: stop the gateway and LM Studio, start the OLD Ollama on
  #    the internal backend port (never the public one — that is the gateway's).
  "$SCRIPT_DIR/gateway.sh" stop || true
  "$SCRIPT_DIR/lmstudio.sh" stop || true
  if ! OLLAMA_HOST="127.0.0.1:$BCP_LLM_OLLAMA_PORT" "$SCRIPT_DIR/ollama.sh" start; then
    report_llm "migrate aborted: could not bring the old Ollama up on $BCP_LLM_OLLAMA_PORT"
    "$SCRIPT_DIR/lmstudio.sh" start || true
    "$SCRIPT_DIR/gateway.sh" start || true
    return 1
  fi
  # 4. Delete ONLY qwen3.5:4b through the explicit project endpoint. Never a
  #    delete-all, never the default 11434 (foreign claude-context embedding).
  local bin
  bin="$(command -v ollama || true)"
  report_llm "deleting qwen3.5:4b from 127.0.0.1:$BCP_LLM_OLLAMA_PORT (explicit)"
  if ! OLLAMA_HOST="127.0.0.1:$BCP_LLM_OLLAMA_PORT" "$bin" rm "qwen3.5:4b"; then
    report_llm "migrate aborted: ollama rm failed — old store untouched elsewhere"
    "$SCRIPT_DIR/ollama.sh" stop || true
    "$SCRIPT_DIR/lmstudio.sh" start || true
    "$SCRIPT_DIR/gateway.sh" start || true
    return 1
  fi
  # 5. Verify it is gone on the SAME endpoint.
  if OLLAMA_HOST="127.0.0.1:$BCP_LLM_OLLAMA_PORT" "$bin" list 2>/dev/null | grep -q "qwen3.5:4b"; then
    report_llm "migrate aborted: qwen3.5:4b still listed after rm"
    "$SCRIPT_DIR/ollama.sh" stop || true
    "$SCRIPT_DIR/lmstudio.sh" start || true
    "$SCRIPT_DIR/gateway.sh" start || true
    return 1
  fi
  # 6. Stop the old Ollama, bring LM Studio back, and re-open the public port.
  "$SCRIPT_DIR/ollama.sh" stop || true
  if ! "$SCRIPT_DIR/lmstudio.sh" start; then
    report_llm "migrate: 4B removed but LM Studio restart failed — run \`pnpm --filter @bcp/llm setup\`"
    return 1
  fi
  if ! "$SCRIPT_DIR/gateway.sh" start; then
    report_llm "migrate: LM Studio is up but the gateway failed to start — run \`pnpm --filter @bcp/llm start\`"
    return 1
  fi
  report_llm "migration complete: LM Studio 9B active, qwen3.5:4b removed from the project store"
}

case "${1:-}" in
  start)   detect_profile; start ;;
  stop)    detect_profile; stop ;;
  status)  detect_profile; status ;;
  pull)    detect_profile; pull ;;
  setup)   detect_profile; setup ;;
  ensure)  detect_profile; ensure ;;
  migrate) detect_profile; migrate ;;
  *)
    echo "usage: $0 {start|stop|status|pull|setup|migrate|ensure}" >&2
    exit 1
    ;;
esac
