#!/usr/bin/env bash
#
# Lifecycle regression tests for local-llm.sh / ollama.sh / lmstudio.sh.
#
# Drives the real shell scripts against FAKE `ollama`, `lms`, `lsof` and `curl`
# binaries (no real servers, no model downloads). Port ownership is simulated
# through a state dir that the fakes read/write, which is how the tests assert
# "foreign listeners are never signalled", "stale PIDs are not killed", and
# "a project-not-started LM Studio server is reused but not stopped".
#
# Run: bash packages/llm/scripts/test-lifecycle.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA="$SCRIPT_DIR/ollama.sh"
LMSTUDIO="$SCRIPT_DIR/lmstudio.sh"
GATEWAY="$SCRIPT_DIR/gateway.sh"
LOCAL="$SCRIPT_DIR/local-llm.sh"
REAL_NODE="$(command -v node)"

TMP="$(mktemp -d)"
reap_all() {
  local f pid
  for f in "$STATE"/port-*; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    kill -TERM "$pid" 2>/dev/null || true
  done
}
trap 'reap_all; rm -rf "$TMP"' EXIT
FAKE_BIN="$TMP/bin"
STATE="$TMP/state"
mkdir -p "$FAKE_BIN" "$STATE"

FAILURES=0
check() {
  local name="$1"; shift
  if "$@"; then
    echo "  ok    $name"
  else
    echo "  FAIL  $name"
    FAILURES=$((FAILURES + 1))
  fi
}

reset() {
  # Clean any stray fake listeners from earlier tests, then clear state.
  for f in "$STATE"/port-*; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    [ -n "${pid:-}" ] && kill -TERM "$pid" 2>/dev/null || true
    rm -f "$f"
  done
  rm -f "$STATE"/*
}

# Run a real script under the fake environment. Current-shell exports
# (BCP_LLM_PROVIDER, ...) flow through; the fakes share $STATE.
run() {
  local script="$1"; shift
  env \
    BCP_LLM_PROVIDER="${BCP_LLM_PROVIDER:-auto}" \
    BCP_LLM_PORT="${BCP_LLM_PORT:-11435}" \
    BCP_LLM_OLLAMA_PORT="${BCP_LLM_OLLAMA_PORT:-11437}" \
    BCP_LLM_ENABLE="${BCP_LLM_ENABLE:-1}" \
    BCP_LLM_BIN="$FAKE_BIN/ollama" \
    BCP_LLM_LMSTUDIO_BIN="$FAKE_BIN/lms" \
    BCP_LLM_LMSTUDIO_MODEL_KEY="${BCP_LLM_LMSTUDIO_MODEL_KEY:-lmstudio-community/Qwen3.5-9B-GGUF}" \
    BCP_LLM_LMSTUDIO_RUNTIME_KEY="${BCP_LLM_LMSTUDIO_RUNTIME_KEY:-qwen3.5-9b}" \
    BCP_LLM_LMSTUDIO_MODEL_ID="${BCP_LLM_LMSTUDIO_MODEL_ID:-qwen3.5-9b}" \
    BCP_LLM_LMSTUDIO_MODEL_FORMAT="${BCP_LLM_LMSTUDIO_MODEL_FORMAT:-gguf}" \
    BCP_LLM_LMSTUDIO_PORT="${BCP_LLM_LMSTUDIO_PORT:-11436}" \
    BCP_LLM_LMSTUDIO_CONTEXT_LENGTH="${BCP_LLM_LMSTUDIO_CONTEXT_LENGTH:-32768}" \
    BCP_LLM_STATE_DIR="$STATE" \
    PATH="$FAKE_BIN:$PATH" \
    FAKE_LSOF_STATE="$STATE" \
    FAKE_OLLAMA_STATE="$STATE" \
    FAKE_LMS_STATE="$STATE" \
    FAKE_CURL_STATE="$STATE" \
    REAL_NODE="$REAL_NODE" \
    bash "$script" "$@"
}

# A "managed" fake server: alive, marks the port busy with its own PID.
spawn_fake_server() {
  local port="${1:-$BCP_LLM_PORT}"
  nohup bash -c '
    echo $$ >"$1/port-$2"
    trap "rm -f \"$1/port-$2\"; exit 0" TERM INT
    while :; do sleep 10 & wait $!; done' _ "$STATE" "$port" >/dev/null 2>&1 &
  echo $!
}

# Same, but presents as an LM Studio server (health endpoints answer).
spawn_fake_lms_server() {
  local pid
  pid="$(spawn_fake_server "${BCP_LLM_LMSTUDIO_PORT:-11436}")"
  : >"$STATE/is-lms"
  echo "$pid"
}

# ---------------------------------------------------------------------------
# Fake binaries
# ---------------------------------------------------------------------------
cat >"$FAKE_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
STATE="${FAKE_LSOF_STATE:-/tmp}"
port=""
for a in "$@"; do
  case "$a" in
    -iTCP:*) port="${a#-iTCP:}"; port="${port%%:*}" ;;
  esac
done
[ -n "$port" ] || exit 1
pid="$(cat "$STATE/port-$port" 2>/dev/null || true)"
case "$pid" in
  ''|*[!0-9]*) exit 1 ;;
esac
kill -0 "$pid" 2>/dev/null || { rm -f "$STATE/port-$port"; exit 1; }
if [ "${1:-}" = "-t" ]; then echo "$pid"; fi
exit 0
EOF

cat >"$FAKE_BIN/ollama" <<'EOF'
#!/usr/bin/env bash
STATE="${FAKE_OLLAMA_STATE:-/tmp}"
PORT="${BCP_LLM_OLLAMA_PORT:-11437}"
case "${1:-}" in
  serve)
    echo $$ >"$STATE/port-$PORT"
    while :; do sleep 10; done
    ;;
  list)
    { echo "NAME"; cat "$STATE/models.txt" 2>/dev/null || true; }
    ;;
  pull)
    printf '%s\n' "$2" >>"$STATE/pulled.log"
    printf '%s\n' "$2" >>"$STATE/models.txt"
    ;;
  rm)
    echo "OLLAMA_HOST=${OLLAMA_HOST:-unset} rm $2" >>"$STATE/removed.log"
    # Not `sed -i ''` — that is the BSD/macOS spelling; GNU sed reads the empty
    # string as the script and the pattern as a filename, fails, and gets
    # swallowed by `|| true`, so the model is never actually removed on Linux.
    if [ -f "$STATE/models.txt" ]; then
      grep -vx -- "$2" "$STATE/models.txt" >"$STATE/models.txt.tmp" || true
      mv -f "$STATE/models.txt.tmp" "$STATE/models.txt"
    fi
    ;;
  *) exit 1 ;;
esac
exit 0
EOF

cat >"$FAKE_BIN/lms" <<'EOF'
#!/usr/bin/env bash
STATE="${FAKE_LMS_STATE:-/tmp}"
PORT="${BCP_LLM_LMSTUDIO_PORT:-11436}"
log() { printf '%s\n' "$*" >>"$STATE/lms.log"; }
case "${1:-}" in
  server)
    case "${2:-}" in
      start)
        log "server start $*"
        nohup sleep 1000 >/dev/null 2>&1 &
        echo $! >"$STATE/port-$PORT"
        : >"$STATE/server-started"
        : >"$STATE/is-lms"
        ;;
      stop)
        log "server stop $*"
        pid="$(cat "$STATE/port-$PORT" 2>/dev/null || true)"
        [ -n "${pid:-}" ] && kill -TERM "$pid" 2>/dev/null || true
        rm -f "$STATE/port-$PORT"
        rm -f "$STATE/is-lms"
        ;;
    esac
    ;;
  ls)
    { echo "LLM"; cat "$STATE/downloaded.txt" 2>/dev/null || true; }
    ;;
  get)
    log "get $*"
    printf '%s\n' "${BCP_LLM_LMSTUDIO_RUNTIME_KEY:-qwen3.5-9b}" >>"$STATE/downloaded.txt"
    printf '%s\n' "${BCP_LLM_LMSTUDIO_RUNTIME_KEY:-qwen3.5-9b}" >>"$STATE/get.log"
    ;;
  load)
    log "load $*"
    if [[ "$*" == *--estimate-only* ]]; then
      if [ -f "$STATE/estimate-fail" ]; then
        echo "This model may NOT be loaded based on your resource guardrails settings."
        exit 1
      fi
      echo "This model may be loaded based on your resource guardrails settings."
      exit 0
    fi
    : >"$STATE/loaded"
    ;;
  unload)
    log "unload $*"
    rm -f "$STATE/loaded"
    ;;
  *) log "unknown $*"; exit 1 ;;
esac
exit 0
EOF

cat >"$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
STATE="${FAKE_LMS_STATE:-/tmp}"
port=""
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" = "--port" ]; then
    j=$((i + 1)); port="${!j}"; break
  fi
done
[ -n "$port" ] || exec "$REAL_NODE" "$@"
echo $$ >"$STATE/port-$port"
: >"$STATE/gateway-started"
# `while :; do sleep 10; done` 会把 SIGTERM 推迟到前台 sleep 结束才处理，实测能
# 整个漏掉，进程活到天荒地老（本脚本每跑一次泄漏一个孤儿）。`sleep & wait` 让
# bash 立刻响应信号；trap 顺带清掉自己的端口痕迹，否则 port_busy 永远为真。
cleanup() { rm -f "$STATE/port-$port"; exit 0; }
trap cleanup TERM INT
while :; do sleep 10 & wait $!; done
EOF

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
STATE="${FAKE_CURL_STATE:-/tmp}"
url=""
want_code=0
for a in "$@"; do
  case "$a" in
    http://*) url="$a" ;;
    -w*|--write-out*) want_code=1 ;;
  esac
done
# LM Studio endpoints additionally require its internal port and marker: a
# foreign process on either port must NOT look like a healthy LM Studio server.
lms_up=0
internal_pid="$(cat "$STATE/port-${BCP_LLM_LMSTUDIO_PORT:-11436}" 2>/dev/null || true)"
case "$internal_pid" in
  ''|*[!0-9]*) ;;
  *) [ -f "$STATE/is-lms" ] && kill -0 "$internal_pid" 2>/dev/null && lms_up=1 ;;
esac
case "$url" in
  */api/v1/models)
    if [ "$want_code" = "1" ]; then [ "$lms_up" = "1" ] && echo 200 || echo 000; else cat "$STATE/api-models.json" 2>/dev/null || echo '{"models":[]}'; fi
    ;;
  */api/v1/models/load)
    if [ -f "$STATE/rest-load-fail" ]; then
      echo '{"error":{"message":"simulated load failure"}}'
      exit 22
    fi
    cat >"$STATE/api-models.json" <<JSON
{"models":[{"id":"${BCP_LLM_LMSTUDIO_RUNTIME_KEY:-qwen3.5-9b}","format":"${BCP_LLM_LMSTUDIO_MODEL_FORMAT:-gguf}","capabilities":{"vision":true},"loaded_instances":[{"id":"${BCP_LLM_LMSTUDIO_MODEL_ID:-qwen3.5-9b}","config":{"context_length":${BCP_LLM_LMSTUDIO_CONTEXT_LENGTH:-32768}}}]}]}
JSON
    echo "{\"type\":\"llm\",\"instance_id\":\"${BCP_LLM_LMSTUDIO_MODEL_ID:-qwen3.5-9b}\",\"status\":\"loaded\",\"load_config\":{\"context_length\":${BCP_LLM_LMSTUDIO_CONTEXT_LENGTH:-32768}}}"
    ;;
  */v1/models)
    if [ "$want_code" = "1" ]; then [ "$lms_up" = "1" ] && echo 200 || echo 000; else cat "$STATE/openai-models.json" 2>/dev/null || echo '{"data":[]}'; fi
    ;;
  */v1/chat/completions)
    if [ "$want_code" = "1" ]; then [ "$lms_up" = "1" ] && echo 200 || echo 000; else cat "$STATE/chat-response.json" 2>/dev/null || echo '{"choices":[{"message":{"content":"{\"ok\":true}"}}]}'; fi
    ;;
  */api/chat)
    # Ollama's own chat endpoint — ollama.sh's setup smoke-test posts here, not
    # to /v1. Healthy iff the managed server is really listening on its port.
    opid="$(cat "$STATE/port-${BCP_LLM_OLLAMA_PORT:-11437}" 2>/dev/null || true)"
    ok=0
    case "$opid" in
      ''|*[!0-9]*) ;;
      *) kill -0 "$opid" 2>/dev/null && ok=1 ;;
    esac
    if [ "$want_code" = "1" ]; then [ "$ok" = "1" ] && echo 200 || echo 000; else echo '{"message":{"content":"hi"}}'; fi
    ;;
  *) echo 000 ;;
esac
exit 0
EOF

chmod +x "$FAKE_BIN"/*

# Seed a valid loaded-instance response for LM Studio REST checks.
seed_loaded_models() {
  cat >"$STATE/api-models.json" <<EOF
{"models":[{"id":"${BCP_LLM_LMSTUDIO_RUNTIME_KEY:-qwen3.5-9b}","format":"${BCP_LLM_LMSTUDIO_MODEL_FORMAT:-gguf}","capabilities":{"vision":true},"loaded_instances":[{"id":"${BCP_LLM_LMSTUDIO_MODEL_ID:-qwen3.5-9b}","config":{"context_length":${BCP_LLM_LMSTUDIO_CONTEXT_LENGTH:-32768}}}]}]}
EOF
  echo "{\"data\":[{\"id\":\"${BCP_LLM_LMSTUDIO_MODEL_ID:-qwen3.5-9b}\"}]}" >"$STATE/openai-models.json"
}

export BCP_LLM_PORT=11435
export BCP_LLM_OLLAMA_PORT=11437
export BCP_LLM_LMSTUDIO_PORT=11436
export BCP_LLM_MODEL=qwen3.5:4b
export BCP_LLM_PROVIDER=auto

# ---------------------------------------------------------------------------
# Ollama lifecycle
# ---------------------------------------------------------------------------
echo "== Ollama: managed start/stop =="
reset
printf '%s\n' "qwen3.5:4b" >"$STATE/models.txt"
run "$OLLAMA" start
rc=$?
check "managed ollama start succeeds" [ "$rc" -eq 0 ]
check "pid file written" [ -s "$STATE/.llm.pid" ]
check "effective snapshot written" [ -f "$STATE/.llm-runtime.json" ]
run "$OLLAMA" stop
rc=$?
check "managed ollama stop succeeds" [ "$rc" -eq 0 ]
check "snapshot removed on stop" [ ! -f "$STATE/.llm-runtime.json" ]
check "port freed after stop" [ ! -e "$STATE/port-11437" ]

echo "== Ollama: foreign listener is never killed =="
reset
printf '%s\n' "qwen3.5:4b" >"$STATE/models.txt"
FOREIGN="$(spawn_fake_server 11437)"
echo "$FOREIGN" >"$STATE/port-11437"
run "$OLLAMA" start
rc=$?
check "start refuses on foreign port" [ "$rc" -ne 0 ]
run "$OLLAMA" stop
kill -0 "$FOREIGN" 2>/dev/null
check "foreign pid untouched by stop" [ $? -eq 0 ]
kill -TERM "$FOREIGN" 2>/dev/null || true

echo "== Ollama: stale PID does not kill a recycled process =="
reset
RECYCLED="$(spawn_fake_server 11437)"
echo "$RECYCLED" >"$STATE/port-11437"
echo "999999" >"$STATE/.llm.pid"   # claims a dead PID
run "$OLLAMA" stop
kill -0 "$RECYCLED" 2>/dev/null
check "recycled pid survives stop" [ $? -eq 0 ]
kill -TERM "$RECYCLED" 2>/dev/null || true

echo "== Ollama: start fails (no background pull) when model missing =="
reset
run "$OLLAMA" start
rc=$?
check "start fails on missing model" [ "$rc" -ne 0 ]
check "no pull happened" [ ! -s "$STATE/pulled.log" ]
check "no snapshot written" [ ! -f "$STATE/.llm-runtime.json" ]

echo "== Ollama: setup provisions a cold store (pull + smoke + snapshot) =="
reset
run "$OLLAMA" setup
rc=$?
check "setup succeeds with an empty store" [ "$rc" -eq 0 ]
check "model pulled" [ "$(grep -c 'qwen3.5:4b' "$STATE/pulled.log" 2>/dev/null || true)" -ge 1 ]
check "snapshot written" [ -f "$STATE/.llm-runtime.json" ]
check "server left running for the gateway" [ -e "$STATE/port-11437" ]
run "$OLLAMA" stop
check "setup-provisioned server stops cleanly" [ ! -e "$STATE/port-11437" ]

# ---------------------------------------------------------------------------
# LM Studio lifecycle
# ---------------------------------------------------------------------------
echo "== LM Studio: missing CLI fails with install hint =="
reset
err="$STATE/cli-err.txt"
env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" \
  BCP_LLM_ENABLE=1 BCP_LLM_PORT=11435 BCP_LLM_STATE_DIR="$STATE" \
  BCP_LLM_LMSTUDIO_BIN="/nonexistent/lms" \
  bash "$LMSTUDIO" start 2>"$err"
rc=$?
check "missing lms CLI fails" [ "$rc" -ne 0 ]
check "install hint present" grep -q "install LM Studio" "$err"

echo "== LM Studio: full project start =="
reset
seed_loaded_models
printf '%s\n' "qwen3.5-9b" >"$STATE/downloaded.txt"
run "$LMSTUDIO" start
rc=$?
check "lmstudio start succeeds" [ "$rc" -eq 0 ]
check "marker says project-started" [ "$(sed -n 's/^serverStartedByProject=//p' "$STATE/.llm-lmstudio.marker" 2>/dev/null)" = true ]
check "effective snapshot written" [ -f "$STATE/.llm-runtime.json" ]
run "$LMSTUDIO" stop
rc=$?
check "lmstudio stop succeeds" [ "$rc" -eq 0 ]
check "server stopped (internal port freed)" [ ! -e "$STATE/port-11436" ]
check "snapshot removed on stop" [ ! -f "$STATE/.llm-runtime.json" ]

echo "== LM Studio: reuses a project server, does not re-start it =="
reset
seed_loaded_models
printf '%s\n' "qwen3.5-9b" >"$STATE/downloaded.txt"
SPID="$(spawn_fake_lms_server)"
printf 'serverStartedByProject=true\nserverPort=11436\nmodelId=qwen3.5-9b\n' >"$STATE/.llm-lmstudio.marker"
run "$LMSTUDIO" start
rc=$?
check "reuse start succeeds" [ "$rc" -eq 0 ]
check "server not re-started" [ ! -f "$STATE/server-started" ]
check "snapshot written" [ -f "$STATE/.llm-runtime.json" ]
run "$LMSTUDIO" stop
check "project server stopped on stop" [ ! -e "$STATE/port-11436" ]
kill -TERM "$SPID" 2>/dev/null || true

echo "== LM Studio: pre-existing (non-project) server is reused but never stopped =="
reset
seed_loaded_models
printf '%s\n' "qwen3.5-9b" >"$STATE/downloaded.txt"
SPID="$(spawn_fake_lms_server)"
printf 'serverStartedByProject=false\nserverPort=11436\nmodelId=qwen3.5-9b\n' >"$STATE/.llm-lmstudio.marker"
run "$LMSTUDIO" start
rc=$?
check "reuse of pre-existing server succeeds" [ "$rc" -eq 0 ]
run "$LMSTUDIO" stop
kill -0 "$SPID" 2>/dev/null
check "pre-existing server not stopped by project stop" [ $? -eq 0 ]
lines="$(grep -c 'server stop' "$STATE/lms.log" 2>/dev/null || true)"
check "lms server stop not invoked" [ "$lines" = "0" ]
kill -TERM "$SPID" 2>/dev/null || true

echo "== Gateway: owns the public port, never touches a foreign one =="
reset
run "$GATEWAY" start
rc=$?
check "gateway start succeeds" [ "$rc" -eq 0 ]
check "gateway holds the public port" [ -e "$STATE/port-11435" ]
check "gateway pid recorded" [ -s "$STATE/.llm-gateway.pid" ]
run "$GATEWAY" stop
check "public port freed on stop" [ ! -e "$STATE/port-11435" ]
check "gateway pid file removed" [ ! -f "$STATE/.llm-gateway.pid" ]

reset
SPID="$(spawn_fake_server 11435)"
echo "$SPID" >"$STATE/port-11435"
run "$GATEWAY" start
rc=$?
check "gateway refuses a foreign public port" [ "$rc" -ne 0 ]
run "$GATEWAY" stop
kill -0 "$SPID" 2>/dev/null
check "foreign public listener is untouched" [ $? -eq 0 ]
kill -TERM "$SPID" 2>/dev/null || true

echo "== LM Studio: REST load failure prevents a successful snapshot =="
reset
printf '%s\n' "qwen3.5-9b" >"$STATE/downloaded.txt"
: >"$STATE/rest-load-fail"
run "$LMSTUDIO" setup
rc=$?
check "setup fails when REST load fails" [ "$rc" -ne 0 ]
check "no snapshot written" [ ! -f "$STATE/.llm-runtime.json" ]

echo "== LM Studio: loaded instance id mismatch fails start =="
reset
printf '%s\n' "qwen3.5-9b" >"$STATE/downloaded.txt"
# The loaded instance carries the expected id (so `start` skips loading), but
# /v1/models exposes a DIFFERENT model id — verify_loaded must reject this.
cat >"$STATE/api-models.json" <<'JSON'
{"models":[{"id":"qwen3.5-9b","format":"gguf","capabilities":{"vision":true},"loaded_instances":[{"id":"qwen3.5-9b","config":{"context_length":32768}}]}]}
JSON
echo '{"data":[{"id":"wrong-identifier"}]}' >"$STATE/openai-models.json"
run "$LMSTUDIO" start
rc=$?
check "start fails on model id mismatch" [ "$rc" -ne 0 ]
check "no snapshot written" [ ! -f "$STATE/.llm-runtime.json" ]

echo "== LM Studio: start refuses to download a missing model =="
reset
seed_loaded_models
run "$LMSTUDIO" start
rc=$?
check "start fails when model missing" [ "$rc" -ne 0 ]
check "no get/download issued" [ ! -s "$STATE/get.log" ]

echo "== LM Studio: setup downloads when the model is missing =="
reset
seed_loaded_models
run "$LMSTUDIO" setup
rc=$?
check "setup succeeds" [ "$rc" -eq 0 ]
check "model downloaded" [ "$(grep -c 'qwen3.5-9b' "$STATE/get.log" 2>/dev/null || true)" -ge 1 ]
check "snapshot written" [ -f "$STATE/.llm-runtime.json" ]

# ---------------------------------------------------------------------------
# Dispatcher / migrate guardrails
# ---------------------------------------------------------------------------
echo "== Dispatcher: migrate is gated =="
reset
export BCP_LLM_PROVIDER=lmstudio
run "$LOCAL" migrate
rc=$?
check "migrate refuses without BCP_LLM_MIGRATE_CONFIRM" [ "$rc" -ne 0 ]
check "no deletion attempted" [ ! -s "$STATE/removed.log" ]

BCP_LLM_MIGRATE_CONFIRM=yes run "$LOCAL" migrate
rc=$?
check "migrate refuses without live acceptance acknowledgement" [ "$rc" -ne 0 ]
check "no deletion after incomplete acceptance" [ ! -s "$STATE/removed.log" ]

export BCP_LLM_PROVIDER=ollama
run "$LOCAL" migrate
rc=$?
check "migrate refuses when provider is ollama" [ "$rc" -ne 0 ]

echo "== Dispatcher: full migrate deletes only qwen3.5:4b on the explicit host =="
reset
export BCP_LLM_PROVIDER=lmstudio
seed_loaded_models
printf '%s\n' "qwen3.5-9b" >"$STATE/downloaded.txt"
printf '%s\n' "qwen3.5:4b" >"$STATE/models.txt"
BCP_LLM_MIGRATE_CONFIRM=yes BCP_LLM_MIGRATE_LIVE_ACCEPTED=yes run "$LOCAL" migrate
rc=$?
check "migrate succeeds" [ "$rc" -eq 0 ]
check "rm targeted explicit OLLAMA_HOST" [ "$(grep -c 'OLLAMA_HOST=127.0.0.1:11437 rm qwen3.5:4b' "$STATE/removed.log" 2>/dev/null || true)" -ge 1 ]
check "only one rm issued" [ "$(wc -l <"$STATE/removed.log" 2>/dev/null || echo 0)" -eq 1 ]
check "qwen3.5:4b gone from model list" [ "$(grep -c 'qwen3.5:4b' "$STATE/models.txt" 2>/dev/null || true)" -eq 0 ]

# ---------------------------------------------------------------------------
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "all lifecycle tests passed"
  exit 0
fi
echo "$FAILURES test(s) failed"
exit 1
