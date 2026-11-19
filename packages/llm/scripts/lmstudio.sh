#!/usr/bin/env bash
#
# @bcp/llm — LM Studio manager for the ultrago stack.
#
# Manages `lms` (LM Studio's CLI) and an internal LM Studio API server on
# BCP_LLM_LMSTUDIO_PORT. This is a BACKEND only: callers never reach it, the
# gateway on BCP_LLM_PORT does, through the `lmstudio` adapter.
#
#   start   CLI + internal server up, model loaded with the project
#           identifier, verified against /api/v1/models + /v1/models,
#           smoke-tested, snapshot written.
#           NEVER downloads a missing model — fails with the provisioning hint.
#   stop    unload bcp-qwen35-9b always; stop the server ONLY if this project
#           started it (ownership marker), never a pre-existing/foreign server.
#   status  profile + provider + port + ownership + model + loaded + format +
#           vision + first actionable failure.
#   pull    download the model key (never deletes).
#   setup   idempotent: download if missing + start + load + verify + smoke.
#   ensure  prerequisites only (CLI present).
#
# Ownership (spec §8.4): we never signal a process we did not start. Whether we
# started the internal server is recorded in $STATE_DIR/.llm-lmstudio.marker.
# No `pkill -f`, no touching foreign listeners.
#
# CLI/API surface follows the installed `lms --help` and the documented REST
# endpoints (/api/v1/models, /v1/models, /v1/chat/completions). Exact flags are
# pinned to the LM Studio docs; verify against the target version on install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BCP_LLM_STATE_DIR:-$SCRIPT_DIR}"
LOG_FILE="$STATE_DIR/.llm.log"
RUNTIME_FILE="$STATE_DIR/.llm-runtime.json"
MARKER_FILE="$STATE_DIR/.llm-lmstudio.marker"

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
LMSTUDIO_PORT="$(env_val BCP_LLM_LMSTUDIO_PORT)"; LMSTUDIO_PORT="${LMSTUDIO_PORT:-11436}"
# MODEL_KEY = HF 下载 key(lms get 用);RUNTIME_KEY = LM Studio 注册的运行时 key
# (lms ls/load 用)。两者不同名:lms get 把 HF 仓库下载后注册成短 key。
MODEL_KEY="$(env_val BCP_LLM_LMSTUDIO_MODEL_KEY)"; MODEL_KEY="${MODEL_KEY:-lmstudio-community/Qwen3.5-9B-GGUF}"
RUNTIME_KEY="$(env_val BCP_LLM_LMSTUDIO_RUNTIME_KEY)"; RUNTIME_KEY="${RUNTIME_KEY:-qwen3.5-9b}"
MODEL_ID="$(env_val BCP_LLM_LMSTUDIO_MODEL_ID)";   MODEL_ID="${MODEL_ID:-qwen3.5-9b}"
MODEL_FORMAT="$(env_val BCP_LLM_LMSTUDIO_MODEL_FORMAT)"; MODEL_FORMAT="${MODEL_FORMAT:-gguf}"
CONTEXT_LENGTH="$(env_val BCP_LLM_LMSTUDIO_CONTEXT_LENGTH)"; CONTEXT_LENGTH="${CONTEXT_LENGTH:-32768}"
GPU="$(env_val BCP_LLM_LMSTUDIO_GPU)";         GPU="${GPU:-max}"
BIND="$(env_val BCP_LLM_LMSTUDIO_BIND)";       BIND="${BIND:-127.0.0.1}"
LMS_BIN="$(env_val BCP_LLM_LMSTUDIO_BIN)"
if [ -z "$LMS_BIN" ]; then LMS_BIN="$(command -v lms || true)"; fi
# LM Studio's own OpenAI-compatible server. This is an INTERNAL endpoint: the
# public port belongs to the gateway, which reaches this one via the lmstudio
# adapter. Nothing here serves callers directly.
API="http://127.0.0.1:$LMSTUDIO_PORT"

report_llm() { echo "[llm] $*" >&2; }

llm_enabled() { [ "$BCP_LLM_ENABLE" = "1" ]; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# CLI / ownership helpers
# ---------------------------------------------------------------------------
ensure_lms_cli() {
  if [ -n "$LMS_BIN" ] && [ -x "$LMS_BIN" ]; then return 0; fi
  report_llm "lms CLI not found (BCP_LLM_LMSTUDIO_BIN unset, not on PATH)"
  report_llm "  fix: install LM Studio (https://lmstudio.ai) and open it once,"
  report_llm "       or set BCP_LLM_LMSTUDIO_BIN=/path/to/lms in .env"
  return 1
}

marker_value() {
  sed -n "s/^$1=//p" "$MARKER_FILE" 2>/dev/null | head -1
}

write_marker() {
  local started="$1"
  mkdir -p "$STATE_DIR"
  cat >"$MARKER_FILE" <<EOF
serverStartedByProject=$started
serverPort=$LMSTUDIO_PORT
modelId=$MODEL_ID
EOF
}

# Is the server on our port one THIS project started (per the marker)?
project_server() {
  [ "$(marker_value serverStartedByProject)" = "true" ] && \
    [ "$(marker_value serverPort)" = "$LMSTUDIO_PORT" ]
}

# Server ownership summary for status output.
ownership_label() {
  if project_server; then echo "project-started"
  elif port_busy "$LMSTUDIO_PORT"; then echo "pre-existing/foreign"
  else echo "none"; fi
}

# ---------------------------------------------------------------------------
# REST helpers (spec §7 / §9 — an open TCP port is not healthy by itself)
# ---------------------------------------------------------------------------
api_v1_models() { curl -sf --max-time 5 "$API/api/v1/models" 2>/dev/null || true; }
api_models_openai() { curl -sf --max-time 5 "$API/v1/models" 2>/dev/null || true; }
health_ok() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/v1/models" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

# Loaded instance must carry the project identifier, requested format, vision, and the
# configured context length (spec §6.4.5/§6.4.6). Parse one model record rather
# than grep independent fields that could belong to different installed models.
loaded_model_matches() {
  node -e '
    let raw="";
    process.stdin.on("data", c => raw += c).on("end", () => {
      try {
        const [id, context, format] = process.argv.slice(1);
        const models = JSON.parse(raw).models;
        const model = Array.isArray(models) && models.find((candidate) =>
          Array.isArray(candidate.loaded_instances) && candidate.loaded_instances.some((instance) => instance.id === id));
        const instance = model?.loaded_instances.find((candidate) => candidate.id === id);
        process.exit(model?.format === format && model?.capabilities?.vision === true &&
          instance?.config?.context_length === Number(context) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$MODEL_ID" "$CONTEXT_LENGTH" "$MODEL_FORMAT"
}

openai_model_visible() {
  node -e '
    let raw="";
    process.stdin.on("data", c => raw += c).on("end", () => {
      try { process.exit((JSON.parse(raw).data || []).some((model) => model.id === process.argv[1]) ? 0 : 1); }
      catch { process.exit(1); }
    });
  ' "$MODEL_ID"
}

verify_loaded() {
  local models
  models="$(api_v1_models)"
  if ! printf '%s' "$models" | loaded_model_matches; then
    report_llm "loaded $MODEL_ID is missing, non-$MODEL_FORMAT, lacks vision, or has wrong context"
    return 1
  fi
  # /v1/models can briefly lag the freshly loaded instance on a new server —
  # bounded retry, then fail closed.
  local seen=0 n
  for n in $(seq 1 15); do
    if printf '%s' "$(api_models_openai)" | openai_model_visible; then
      seen=1
      break
    fi
    sleep 0.2
  done
  if [ "$seen" -ne 1 ]; then
    report_llm "model id $MODEL_ID not visible via /v1/models"
    return 1
  fi
  return 0
}

model_installed() {
  "$LMS_BIN" ls 2>/dev/null | grep -q "$RUNTIME_KEY"
}

estimate_ok() {
  local out
  out="$("$LMS_BIN" load "$RUNTIME_KEY" --gpu "$GPU" --context-length "$CONTEXT_LENGTH" --estimate-only 2>&1 || true)"
  printf '%s\n' "$out" | grep -qi "may be loaded"
}

load_model() {
  # `lms load` cannot reliably select a GGUF variant when an MLX model has the
  # same display name (LM Studio #1462). Native REST loads the exact indexed key
  # and returns the applied config, so this is both non-interactive and verifiable.
  report_llm "loading $RUNTIME_KEY (format=$MODEL_FORMAT ctx=$CONTEXT_LENGTH) via LM Studio REST"
  local body response
  body="$(node -e 'process.stdout.write(JSON.stringify({model:process.argv[1],context_length:Number(process.argv[2]),flash_attention:true,offload_kv_cache_to_gpu:true,echo_load_config:true}))' "$RUNTIME_KEY" "$CONTEXT_LENGTH")"
  response="$(curl -sf --max-time 300 -H 'Content-Type: application/json' -d "$body" "$API/api/v1/models/load" 2>&1)" || {
    report_llm "LM Studio REST load failed: ${response:0:500}"
    return 1
  }
  if ! printf '%s' "$response" | node -e '
    let raw="";
    process.stdin.on("data", c => raw += c).on("end", () => {
      try {
        const payload = JSON.parse(raw);
        process.exit(payload.status === "loaded" &&
          payload.load_config?.context_length === Number(process.argv[1]) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$CONTEXT_LENGTH"; then
    report_llm "LM Studio loaded $RUNTIME_KEY without the requested ctx=$CONTEXT_LENGTH"
    return 1
  fi
  for _ in $(seq 1 150); do
    api_v1_models | grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$MODEL_ID\"" && return 0
    sleep 0.2
  done
  report_llm "model $MODEL_ID did not appear as loaded — inspect \`lms ps\`"
  return 1
}

# ---------------------------------------------------------------------------
# Smoke tests hit LM Studio's own OpenAI endpoint. Text must be nonempty and
# structured output must parse. Vision capability is verified from exact loaded
# model metadata; the full WebP request is a live acceptance check because this
# model may spend minutes reasoning over an image before emitting final text.
# ---------------------------------------------------------------------------
smoke_payload() {
  local body="$1" payload err_file
  # curl 的 stderr 必须落盘带出来：-f 模式下 4xx/超时只表现为空 payload，
  # 吞掉 stderr 会把畸形请求体这类问题变成一句不可诊断的 "smoke failed"。
  err_file="$(mktemp)"
  if ! payload="$(curl -fsS --max-time 90 -H 'Content-Type: application/json' -d "$body" "$API/v1/chat/completions" 2>"$err_file")"; then
    report_llm "smoke request failed: $(tr '\n' ' ' <"$err_file" | head -c 300)"
    rm -f "$err_file"
    return 1
  fi
  rm -f "$err_file"
  printf '%s' "$payload"
}

smoke_text() {
  local payload
  payload="$(smoke_payload "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}],\"stream\":false}" || true)"
  printf '%s' "$payload" | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const c=JSON.parse(raw).choices?.[0]?.message?.content;process.exit(typeof c==="string"&&c.trim()?0:1)}catch{process.exit(1)}})'
}

smoke_json() {
  local payload
  payload="$(smoke_payload "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Return JSON with ok true\"}],\"stream\":false,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"bcp_smoke\",\"strict\":true,\"schema\":{\"type\":\"object\",\"properties\":{\"ok\":{\"type\":\"boolean\"}},\"required\":[\"ok\"]}}}}" || true)"
  printf '%s' "$payload" | node -e 'let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{try{const p=JSON.parse(raw);const value=JSON.parse(p.choices?.[0]?.message?.content);process.exit(value.ok===true?0:1)}catch{process.exit(1)}})'
}

smoke_tests() {
  smoke_text || { report_llm "smoke: text request failed"; return 1; }
  smoke_json || { report_llm "smoke: structured JSON request failed"; return 1; }
  report_llm "smoke: text + structured JSON OK; exact model metadata confirms vision"
  return 0
}

# ---------------------------------------------------------------------------
# Effective runtime snapshot (spec §7.3)
# ---------------------------------------------------------------------------
write_snapshot() {
  mkdir -p "$STATE_DIR"
  cat >"$RUNTIME_FILE" <<EOF
{
  "schemaVersion": 1,
  "profile": "mac-apple-silicon-16gb",
  "provider": "lmstudio",
  "baseUrl": "$API",
  "apiStyle": "openai-compatible",
  "model": "$MODEL_ID",
  "modelKey": "$MODEL_KEY",
  "contextLength": $CONTEXT_LENGTH,
  "format": "$MODEL_FORMAT",
  "vision": true,
  "serverStartedByProject": $(project_server && echo true || echo false),
  "resolvedAt": "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
}
EOF
  report_llm "wrote effective runtime snapshot -> $RUNTIME_FILE"
}

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
start_server() {
  if port_busy "$LMSTUDIO_PORT"; then
    if health_ok; then
      # An LM Studio server answers on our port — reuse it. Ownership marker:
      # keep "true" when it is still the server this project started; otherwise
      # record that it is pre-existing so `stop` will not stop a foreign server.
      if project_server; then
        report_llm "reusing project LM Studio server on $BIND:$LMSTUDIO_PORT"
      else
        report_llm "reusing pre-existing LM Studio server on $BIND:$LMSTUDIO_PORT (not project-started)"
        write_marker false
      fi
      return 0
    fi
    report_llm "internal LM Studio port $LMSTUDIO_PORT is held by a FOREIGN process — not ours to manage"
    report_llm "  free it or set BCP_LLM_LMSTUDIO_PORT elsewhere"
    return 1
  fi
  report_llm "starting LM Studio server on $BIND:$LMSTUDIO_PORT (internal loopback)"
  if ! "$LMS_BIN" server start --port "$LMSTUDIO_PORT" --bind "$BIND" >>"$LOG_FILE" 2>&1; then
    report_llm "lms server start failed — see $LOG_FILE"
    return 1
  fi
  for _ in $(seq 1 300); do port_busy "$LMSTUDIO_PORT" && break; sleep 0.2; done
  if ! port_busy "$LMSTUDIO_PORT"; then
    report_llm "LM Studio server did not come up on $LMSTUDIO_PORT — see $LOG_FILE"
    return 1
  fi
  write_marker true
  report_llm "LM Studio server up (internal port $LMSTUDIO_PORT)"
  return 0
}

start() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  ensure_lms_cli || return 1
  start_server || return 1
  if ! model_installed; then
    report_llm "model key $MODEL_KEY missing — start refuses to download"
    report_llm "  fix: pnpm --filter @bcp/llm pull   (or: pnpm run llm:setup)"
    return 1
  fi
  if ! api_v1_models | grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$MODEL_ID\""; then
    load_model || return 1
  fi
  verify_loaded || return 1
  smoke_tests || return 1
  write_snapshot
  report_llm "LM Studio ready: $MODEL_ID ($MODEL_FORMAT, vision, ctx=$CONTEXT_LENGTH) on $API"
  return 0
}

stop() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  if [ -n "$LMS_BIN" ] && [ -x "$LMS_BIN" ]; then
    report_llm "unloading project model $MODEL_ID"
    "$LMS_BIN" unload "$MODEL_ID" >>"$LOG_FILE" 2>&1 || true
    if project_server; then
      report_llm "stopping project LM Studio server (marker says we started it)"
      "$LMS_BIN" server stop >>"$LOG_FILE" 2>&1 || true
      for _ in $(seq 1 100); do ! port_busy "$LMSTUDIO_PORT" && break; sleep 0.2; done
      if port_busy "$LMSTUDIO_PORT"; then
        report_llm "warning: internal port $LMSTUDIO_PORT still busy after lms server stop — leaving untouched"
      fi
    else
      report_llm "server was pre-existing — NOT stopping it (unloaded project model only)"
    fi
  else
    report_llm "lms CLI not found — cannot unload model or stop server"
  fi
  rm -f "$RUNTIME_FILE"
  rm -f "$MARKER_FILE"
}

status() {
  echo "bin:       ${LMS_BIN:-<not found>}"
  if port_busy "$LMSTUDIO_PORT"; then
    echo "backend:   $API (up)"
  else
    echo "backend:   $API (down)"
  fi
  echo "ownership: $(ownership_label)"
  echo "modelKey:  $MODEL_KEY"
  echo "modelId:   $MODEL_ID"
  echo "context:   $CONTEXT_LENGTH"
  local models
  models="$(api_v1_models)"
  if [ -n "$models" ]; then
    if printf '%s' "$models" | grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$MODEL_ID\""; then
      echo "loaded:    yes"
    else
      echo "loaded:    no"
    fi
    printf '%s' "$models" | grep -q "\"format\"[[:space:]]*:[[:space:]]*\"$MODEL_FORMAT\"" && echo "format:    $MODEL_FORMAT" || echo "format:    unknown"
    printf '%s' "$models" | grep -q '"vision"[[:space:]]*:[[:space:]]*true' && echo "vision:    true" || echo "vision:    unknown"
  else
    echo "loaded:    (server down)"
    echo "format:    (server down)"
    echo "vision:    (server down)"
  fi
  echo "--- lms ls ---"
  "$LMS_BIN" ls 2>/dev/null || true
  echo "--- lms ps ---"
  "$LMS_BIN" ps 2>/dev/null || true
}

ensure() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  ensure_lms_cli
}

pull() {
  ensure_lms_cli || return 1
  report_llm "downloading $MODEL_KEY (foreground)"
  if ! "$LMS_BIN" get "$MODEL_KEY" </dev/null; then
    # LM Studio Hub 可能索引不到该 HF 仓库,回退用完整 URL 下载(spec §8.3)。
    report_llm "name lookup failed — retrying with full HF URL"
    "$LMS_BIN" get "https://huggingface.co/$MODEL_KEY" </dev/null || return 1
  fi
  if ! model_installed; then
    report_llm "download finished but $RUNTIME_KEY not listed by \`lms ls\`"
    return 1
  fi
  report_llm "done: $MODEL_KEY downloaded"
}

setup() {
  llm_enabled || { report_llm "disabled (BCP_LLM_ENABLE=0) — skipping"; return 0; }
  ensure_lms_cli || return 1
  if ! model_installed; then
    report_llm "pulling $MODEL_KEY (foreground, setup)"
    if ! "$LMS_BIN" get "$MODEL_KEY" </dev/null; then
      report_llm "name lookup failed — retrying with full HF URL"
      "$LMS_BIN" get "https://huggingface.co/$MODEL_KEY" </dev/null || return 1
    fi
  fi
  start_server || return 1
  if ! api_v1_models | grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$MODEL_ID\""; then
    load_model || return 1
  fi
  verify_loaded || return 1
  smoke_tests || return 1
  write_snapshot
  report_llm "setup complete: $MODEL_ID ready on $API"
  return 0
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
