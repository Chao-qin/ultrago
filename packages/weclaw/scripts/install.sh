#!/usr/bin/env bash
# Download the latest WeClaw binary into ./bin/
# Idempotent: if the binary is present and matches the installed version, exits 0.
set -euo pipefail

REPO="fastclaw-ai/weclaw"
BINARY="weclaw"
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${PKG_DIR}/bin"
INSTALL_PATH="${BIN_DIR}/${BINARY}"

# Repo root = parent of packages/, so config dir defaults to packages/weclaw/config.
# When called from a checkout the script can find repo root via the
# nearest pnpm-workspace.yaml.
find_repo_root() {
  local d="${PKG_DIR}"
  while [ "${d}" != "/" ]; do
    if [ -f "${d}/pnpm-workspace.yaml" ]; then
      echo "${d}"
      return 0
    fi
    d="$(dirname "${d}")"
  done
  echo "${PKG_DIR}" # fall back to package dir
}
REPO_ROOT="$(find_repo_root)"
CONFIG_DIR="${WECLAW_CONFIG_DIR:-${PKG_DIR}/config}"

# OS / arch detection
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "${OS}" in
  darwin|linux) ;;
  *) echo "Unsupported OS: ${OS}" >&2; exit 1 ;;
esac
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported arch: ${ARCH}" >&2; exit 1 ;;
esac

mkdir -p "${BIN_DIR}"

# Already installed? Verify version is non-empty.
if [ -x "${INSTALL_PATH}" ]; then
  CUR_VERSION="$("${INSTALL_PATH}" version 2>/dev/null || true)"
  if [ -n "${CUR_VERSION}" ]; then
    echo "✓ weclaw already installed: ${CUR_VERSION} (${INSTALL_PATH})"
    echo "  run scripts/update.sh to upgrade"
    exit 0
  fi
fi

echo "→ Detected ${OS}/${ARCH}"
echo "→ Fetching latest release..."
VERSION="$(curl -fsSL -H 'User-Agent: weclaw-install' \
  "https://api.github.com/repos/${REPO}/releases/latest" \
  | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p')"

if [ -z "${VERSION}" ]; then
  echo "✗ Failed to determine latest version" >&2
  echo "  hint: check https://github.com/${REPO}/releases/latest" >&2
  exit 1
fi

FILENAME="${BINARY}_${OS}_${ARCH}"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILENAME}"
echo "→ Downloading ${URL}"

TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT
if ! curl -fsSL -o "${TMP}" "${URL}"; then
  echo "✗ Download failed (no asset for ${OS}/${ARCH} in ${VERSION}?)" >&2
  exit 1
fi

chmod +x "${TMP}"
mv "${TMP}" "${INSTALL_PATH}"

# macOS quarantine cleanup (harmless on Linux).
if [ "${OS}" = "darwin" ]; then
  xattr -d com.apple.quarantine "${INSTALL_PATH}" 2>/dev/null || true
  xattr -d com.apple.provenance "${INSTALL_PATH}" 2>/dev/null || true
fi

mkdir -p "${CONFIG_DIR}"
echo ""
echo "✓ weclaw ${VERSION} installed → ${INSTALL_PATH}"
echo "  config dir : ${CONFIG_DIR}"
echo "  test       : ${INSTALL_PATH} version"
