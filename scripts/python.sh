#!/usr/bin/env bash
set -euo pipefail

PYTHON_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PYTHON="$PYTHON_PROJECT_ROOT/.venv/bin/python"

if [ ! -x "$PROJECT_PYTHON" ]; then
  echo '[python] 项目 Python 环境缺失，请先在项目根目录执行 pnpm python:setup' >&2
  exit 1
fi

unset PYTHONHOME PYTHONPATH
export PYTHONNOUSERSITE=1
export VIRTUAL_ENV="$PYTHON_PROJECT_ROOT/.venv"
export PATH="$VIRTUAL_ENV/bin:$PATH"

"$PROJECT_PYTHON" "$PYTHON_PROJECT_ROOT/scripts/check-python-runtime.py"
exec "$PROJECT_PYTHON" "$@"
