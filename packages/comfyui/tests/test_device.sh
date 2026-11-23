#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../scripts/device.sh"

assert_python_path() {
  local expected="$1"
  local actual
  actual="$(venv_python_path "$2" "/project/ComfyUI/.venv")"
  if [ "$actual" != "$expected" ]; then
    echo "expected $expected, got $actual" >&2
    exit 1
  fi
}

assert_backend() {
  local expected="$1"
  shift
  local actual
  actual="$(detect_backend "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "expected $expected, got $actual for: $*" >&2
    exit 1
  fi
}

assert_python_path "/project/ComfyUI/.venv/Scripts/python.exe" "MINGW64_NT-10.0"
assert_python_path "/project/ComfyUI/.venv/bin/python" "Darwin"
assert_backend mps Darwin arm64 no ""
assert_backend mps Darwin x86_64 no "AMD Radeon Pro"
assert_backend unsupported Darwin x86_64 no "Intel UHD Graphics"
assert_backend cuda MINGW64_NT-10.0 x86_64 yes "NVIDIA GeForce RTX"
assert_backend cuda MSYS_NT-10.0 x86_64 no "NVIDIA GeForce RTX"
assert_backend directml MINGW64_NT-10.0 x86_64 no "AMD Radeon RX"
assert_backend directml MINGW64_NT-10.0 x86_64 no "Intel Arc"
assert_backend unsupported MINGW64_NT-10.0 x86_64 no "Other Vendor Adapter"
assert_backend cpu MINGW64_NT-10.0 x86_64 no ""
assert_backend cpu MINGW64_NT-10.0 x86_64 no "Microsoft Basic Display Adapter"
assert_backend cuda Linux x86_64 yes ""
assert_backend cpu Linux x86_64 no ""

echo "device detection tests passed"
