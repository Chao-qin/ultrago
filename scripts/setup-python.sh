#!/usr/bin/env bash
set -euo pipefail

PYTHON_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v uv >/dev/null 2>&1; then
  echo '[python] 请先安装 uv：https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi

cd "$PYTHON_PROJECT_ROOT"
export UV_PROJECT_ENVIRONMENT="$PYTHON_PROJECT_ROOT/.venv"
uv sync --locked --managed-python --python "$(cat .python-version)"
bash scripts/python.sh scripts/check-python-runtime.py --montage --report
