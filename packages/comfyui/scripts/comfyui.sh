#!/usr/bin/env bash
#
# @bcp/comfyui — ComfyUI with automatic device selection + FlexAI remote-model node.
#
# ComfyUI itself is NOT committed: `setup` clones the pinned upstream commits
# into ./ComfyUI (git-ignored). Generation runs on a remote OpenAI-compatible
# image API through the FlexAI custom node, so no local GPU / model is needed.
#
# Commands:
#   setup    idempotent: clone pinned ComfyUI + FlexAI, create venv, install
#            device-specific torch + requirements, link .env / flexai_models.json and
#            the local nodes (../nodes/bcp), download the 2x upscale model,
#            copy ../workflows/*.json into ComfyUI (never overwriting),
#            install ComfyUI-Manager (pip package) + rgthree-comfy + ComfyUI-RMBG
#   start    start ComfyUI in the background (pid + log in ./ComfyUI)
#   stop     stop ONLY the process this script started (pid file)
#   status   pid + HTTP health check
#   check    offline tests for ../nodes/bcp (exit 2 when not set up)
#
# Config: ../.env (git-ignored, copy from .env.example) holds the remote API
# base url + key; ../flexai_models.json is the model dropdown list.
#   COMFYUI_LISTEN (default 0.0.0.0)  COMFYUI_PORT (default 8188)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMFY_DIR="$PKG_DIR/ComfyUI"
FLEXAI_DIR="$COMFY_DIR/custom_nodes/Comfyui-flexai"
source "$(dirname "${BASH_SOURCE[0]}")/device.sh"
PY="$(venv_python_path "$(uname -s)" "$COMFY_DIR/.venv")"
PID_FILE="$COMFY_DIR/.comfyui.pid"
LOG_FILE="$COMFY_DIR/comfyui.log"

COMFYUI_REPO="https://github.com/comfyanonymous/ComfyUI.git"
COMFYUI_REF="1d2ea2948d33dfda4d7cfe58c6d234968aa62cf8"
FLEXAI_REPO="https://github.com/Semonxue/Comfyui-flexai.git"
FLEXAI_REF="a5acb9fd19d46aede95027056a903f1a0d5844c5"
RGTHREE_REPO="https://github.com/rgthree/rgthree-comfy.git"
RGTHREE_REF="d7297b42f0fa78bec1c0411478f887423c249502"
RMBG_REPO="https://github.com/1038lab/ComfyUI-RMBG.git"
RMBG_REF="229529e0ea63fb7085848225d74f91f6dc164956"
UPSCALE_MODEL_URL="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"

COMFYUI_LISTEN="${COMFYUI_LISTEN:-0.0.0.0}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"

report() { echo "[comfyui] $*" >&2; }

selected_backend() {
  local nvidia="no" gpu_names
  detect_nvidia_gpu && nvidia="yes"
  gpu_names="$(detect_platform_gpus)"
  detect_backend "$(uname -s)" "$(uname -m)" "$nvidia" "$gpu_names"
}

install_torch() {
  local backend="$1"
  report "installing PyTorch backend: $backend"
  case "$backend" in
    cuda)
      uv pip install -q --python "$PY" torch torchvision torchaudio \
        --index-url https://download.pytorch.org/whl/cu128
      ;;
    mps)
      uv pip install -q --python "$PY" torch torchvision torchaudio
      ;;
    directml)
      uv pip install -q --python "$PY" torch-directml
      ;;
    unsupported)
      report "a GPU was detected, but this device has no supported PyTorch backend"
      return 1
      ;;
    cpu)
      uv pip install -q --python "$PY" torch torchvision torchaudio \
        --index-url https://download.pytorch.org/whl/cpu
      ;;
    *)
      report "unsupported device backend: $backend"
      return 1
      ;;
  esac
}

verify_torch_backend() {
  local backend="$1"
  "$PY" -c '
import sys
backend = sys.argv[1]
if backend == "cuda":
    import torch
    ok = torch.cuda.is_available()
elif backend == "mps":
    import torch
    ok = torch.backends.mps.is_available()
elif backend == "directml":
    import torch_directml
    ok = torch_directml.device_count() > 0
else:
    ok = True
if not ok:
    raise SystemExit(f"Detected {backend} GPU, but its PyTorch backend is unavailable")
' "$backend"
}

# Clone $1 into $3 at commit $2; leave an existing checkout untouched.
checkout_pinned() {
  local repo="$1" ref="$2" dir="$3"
  if [ -d "$dir/.git" ]; then
    report "$(basename "$dir") exists ($(git -C "$dir" rev-parse --short HEAD)), skip clone"
    return
  fi
  git init -q "$dir"
  git -C "$dir" remote add origin "$repo"
  git -C "$dir" fetch -q --depth 1 origin "$ref"
  git -C "$dir" checkout -q FETCH_HEAD
  report "cloned $(basename "$dir") @ ${ref:0:7}"
}

setup() {
  command -v uv >/dev/null || { report "uv not found: https://docs.astral.sh/uv/"; exit 1; }
  checkout_pinned "$COMFYUI_REPO" "$COMFYUI_REF" "$COMFY_DIR"
  checkout_pinned "$FLEXAI_REPO" "$FLEXAI_REF" "$FLEXAI_DIR"
  checkout_pinned "$RGTHREE_REPO" "$RGTHREE_REF" "$COMFY_DIR/custom_nodes/rgthree-comfy"
  checkout_pinned "$RMBG_REPO" "$RMBG_REF" "$COMFY_DIR/custom_nodes/ComfyUI-RMBG"
  # 上游 bug：加载失败时打印了未定义的 module_name，任何一个节点文件缺依赖（如 SAM3 要 triton）
  # 都会让整个包加载失败。改成打印 file.stem，出错的文件被跳过，其余节点照常加载。
  perl -pi -e 's/Error loading \{module_name\}: \{e\}/Error loading {file.stem}: {e}/' \
    "$COMFY_DIR/custom_nodes/ComfyUI-RMBG/__init__.py"

  [ -x "$PY" ] || uv venv -q --python 3.12 "$COMFY_DIR/.venv"
  local backend
  backend="$(selected_backend)"
  install_torch "$backend"
  verify_torch_backend "$backend"
  grep -vE '^[[:space:]]*(torch|torchvision|torchaudio)([[:space:]<=>~!;#]|$)' "$COMFY_DIR/requirements.txt" \
    | uv pip install -q --python "$PY" -r /dev/stdin \
    -r "$FLEXAI_DIR/requirements.txt" -r "$COMFY_DIR/manager_requirements.txt"
  # RMBG 的依赖去掉三项：onnxruntime-gpu 是显卡版（会和 CPU 版 onnxruntime 冲突），
  # groundingdino-py 要编译，只有按文字分割的节点用它，抠图用不到；
  # decord 只有 linux/windows 轮子（macOS arm64 解析不到），只有 SAM3 读视频用它，
  # 而 SAM3 本来就缺依赖不加载
  grep -vE '^\s*(onnxruntime-gpu|groundingdino-py|decord)' "$COMFY_DIR/custom_nodes/ComfyUI-RMBG/requirements.txt" \
    | uv pip install -q --python "$PY" -r /dev/stdin
  verify_torch_backend "$backend"

  [ -f "$PKG_DIR/.env" ] || { cp "$PKG_DIR/.env.example" "$PKG_DIR/.env"; chmod 600 "$PKG_DIR/.env"; }
  ln -sfn ../../../.env "$FLEXAI_DIR/.env"
  ln -sfn ../../../flexai_models.json "$FLEXAI_DIR/flexai_models.json"
  ln -sfn ../../nodes/bcp "$COMFY_DIR/custom_nodes/bcp"
  local upscale="$COMFY_DIR/models/upscale_models/$(basename "$UPSCALE_MODEL_URL")"
  [ -f "$upscale" ] || { curl -fL --retry 3 -o "$upscale.part" "$UPSCALE_MODEL_URL" && mv "$upscale.part" "$upscale"; }
  # 只补缺的：界面里改过的同名工作流不覆盖。不用 cp -n：coreutils 9.2 起它跳过时返回失败，会被 set -e 中断
  local wf_dir="$COMFY_DIR/user/default/workflows" wf
  mkdir -p "$wf_dir"
  for wf in "$PKG_DIR"/workflows/*.json; do
    [ -e "$wf_dir/$(basename "$wf")" ] || cp "$wf" "$wf_dir/"
  done
  report "setup done; fill in $PKG_DIR/.env, then: pnpm --filter @bcp/comfyui start"
}

running_pid() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

start() {
  [ -x "$PY" ] || { report "not set up yet: pnpm --filter @bcp/comfyui run setup"; exit 1; }
  if pid="$(running_pid)"; then report "already running (pid $pid)"; return; fi
  local backend
  backend="$(selected_backend)"
  verify_torch_backend "$backend"
  local -a device_args=()
  case "$backend" in
    cpu) device_args=(--cpu) ;;
    directml) device_args=(--directml) ;;
  esac
  report "starting with device backend: $backend"
  cd "$COMFY_DIR"
  nohup "$PY" main.py "${device_args[@]}" --enable-manager --listen "$COMFYUI_LISTEN" --port "$COMFYUI_PORT" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 90); do
    if curl -fs -o /dev/null "http://127.0.0.1:$COMFYUI_PORT/system_stats"; then
      report "up: http://$COMFYUI_LISTEN:$COMFYUI_PORT (pid $(cat "$PID_FILE"), log $LOG_FILE)"
      return
    fi
    running_pid >/dev/null || break
    sleep 1
  done
  report "failed to start, see $LOG_FILE"; tail -20 "$LOG_FILE" >&2; exit 1
}

stop() {
  if pid="$(running_pid)"; then
    kill "$pid"; rm -f "$PID_FILE"; report "stopped (pid $pid)"
  else
    rm -f "$PID_FILE"; report "not running"
  fi
}

status() {
  if pid="$(running_pid)"; then
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$COMFYUI_PORT/system_stats" || true)"
    report "running (pid $pid), port $COMFYUI_PORT, /system_stats HTTP $code"
  else
    report "not running"
  fi
}

check() {
  [ -x "$PY" ] || { report "not set up yet, cannot run node tests: pnpm --filter @bcp/comfyui run setup"; exit 2; }
  cd "$PKG_DIR" && "$PY" -m unittest discover -s tests -v
}

case "${1:-}" in
  setup|start|stop|status|check) "$1" ;;
  *) echo "usage: $0 {setup|start|stop|status|check}" >&2; exit 2 ;;
esac
