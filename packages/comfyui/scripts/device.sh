#!/usr/bin/env bash

venv_python_path() {
  local os="$1"
  local venv_dir="$2"
  case "$os" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo "$venv_dir/Scripts/python.exe" ;;
    *) echo "$venv_dir/bin/python" ;;
  esac
}

detect_backend() {
  local os="${1:-$(uname -s)}"
  local arch="${2:-$(uname -m)}"
  local nvidia="${3:-}"
  local gpu_names="${4:-}"

  case "$os" in
    Darwin)
      if [ "$arch" = "arm64" ] || printf '%s' "$gpu_names" | grep -Eiq 'AMD|Radeon'; then
        echo mps
      elif [ -n "$gpu_names" ]; then
        echo unsupported
      else
        echo cpu
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      if [ "$nvidia" = "yes" ] || printf '%s' "$gpu_names" | grep -Eiq 'NVIDIA'; then
        echo cuda
      elif printf '%s' "$gpu_names" | grep -Eiq 'AMD|Radeon|Intel'; then
        echo directml
      elif [ -n "$gpu_names" ] && ! printf '%s' "$gpu_names" | grep -Eiq 'Microsoft Basic Display|Remote Display|Virtual Display|Indirect Display'; then
        echo unsupported
      elif [ -n "$gpu_names" ]; then
        echo cpu
      else
        echo cpu
      fi
      ;;
    Linux)
      if [ "$nvidia" = "yes" ]; then
        echo cuda
      else
        echo cpu
      fi
      ;;
    *)
      echo cpu
      ;;
  esac
}

detect_nvidia_gpu() {
  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1
}

detect_platform_gpus() {
  case "$(uname -s)" in
    Darwin)
      system_profiler SPDisplaysDataType 2>/dev/null \
        | awk -F ': ' '/Chipset Model|Chip Model/ {print $2}'
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      local powershell=""
      if command -v powershell.exe >/dev/null 2>&1; then
        powershell="powershell.exe"
      elif command -v pwsh.exe >/dev/null 2>&1; then
        powershell="pwsh.exe"
      fi
      if [ -n "$powershell" ]; then
        "$powershell" -NoProfile -Command \
          'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }' 2>/dev/null \
          | tr -d '\r'
      fi
      ;;
  esac
}
