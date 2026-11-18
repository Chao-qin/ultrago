#!/usr/bin/env bash
# Upgrade weclaw to the latest release (replaces the binary in place).
set -euo pipefail
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_PATH="${PKG_DIR}/bin/weclaw"

if [ ! -x "${INSTALL_PATH}" ]; then
  echo "→ No existing binary, falling back to install.sh"
  exec "${PKG_DIR}/scripts/install.sh"
fi

CUR="$("${INSTALL_PATH}" version 2>/dev/null || echo unknown)"
echo "Current: ${CUR}"

# Force re-download by removing the binary and re-running install.
rm -f "${INSTALL_PATH}"
exec "${PKG_DIR}/scripts/install.sh"
