#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPSTREAM_COMMIT="10711d0c6b7e2b0a784f808ef2f07ba83c2b9023"
BUILD_STAMP="${UPSTREAM_COMMIT}-external-errors-v2"
STAMP_FILE="$ROOT/packages/weclaw/bin/.external-delivery-commit"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/weclaw-build.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

git clone --quiet https://github.com/fastclaw-ai/weclaw.git "$TMP_DIR/weclaw"
git -C "$TMP_DIR/weclaw" checkout --quiet "$UPSTREAM_COMMIT"
git -C "$TMP_DIR/weclaw" apply "$ROOT/packages/weclaw/patches/external-delivery.patch"

(
  cd "$TMP_DIR/weclaw"
  go test ./...
  go build -o "$ROOT/packages/weclaw/bin/weclaw" .
)

chmod +x "$ROOT/packages/weclaw/bin/weclaw"
printf '%s\n' "$BUILD_STAMP" > "$STAMP_FILE"
printf 'Built %s from fastclaw-ai/weclaw@%s\n' \
  "$ROOT/packages/weclaw/bin/weclaw" "$UPSTREAM_COMMIT"
