#!/usr/bin/env bash
set -euo pipefail

PYTHON_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PYTHON_PROJECT_ROOT"
node --test scripts/test-python-runtime.mjs
for directory in .claude/skills/product-preprocess .claude/skills/product-preprocess/projection; do
  for suite in "$directory"/test_*.py; do
    bash scripts/python.sh scripts/run-python-tests.py "$suite"
  done
done
for suite in test_phase_timings.py test_preprocess_wrapper.py; do
  bash scripts/python.sh scripts/run-python-tests.py ".claude/skills/product-preprocess/scripts/$suite"
done
bash scripts/python.sh .claude/skills/product-preprocess/scripts/test_vision_image.py
