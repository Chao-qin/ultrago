#!/usr/bin/env bash
#
# First-time / post-move environment initialization for ultrago.
#
# Idempotent: every step skips itself if the target is already in place, so
# running this on a fresh checkout, after a directory move, or after a `git
# clean` all behave the same. It does NOT start any service — pair with
# `pnpm start` (or `bash scripts/backend.sh start`) for that.
#
# What it does:
#   1. pnpm install              — node_modules for all workspace packages
#   2. .env                      — create from .env.example if missing
#   3. weclaw symlink            — ~/.weclaw → <repo>/packages/weclaw/config
#                                  (weclaw hardcodes this path with no CLI override)
#   4. console data dir          — resource/db/ for the SQLite file
#   5. prisma migrate deploy    — apply console.db migrations to schema.prisma
#   6. (optional) playwright     — `pnpm --filter @bcp/backend exec playwright install chromium`
#                                  only if `playwright` is on PATH already
#   7. (optional) ollama binary  — the local LLM server, skipped when
#                                  BCP_LLM_ENABLE=0 or it is already installed
#
# Usage:  bash scripts/init.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[1;34m[init]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[init]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[init]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Sanity: pnpm + node available ──
command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH — install it first (corepack enable && corepack prepare pnpm@10.24.0 --activate)"
command -v node >/dev/null 2>&1 || die "node is not on PATH"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "node >= 20 is required (found $(node -v))"

bash "$ROOT/scripts/setup-python.sh"

# ── 1. pnpm install ──
if [ -d "$ROOT/node_modules" ] && [ -d "$ROOT/packages/backend/node_modules" ]; then
  say "node_modules already present — skipping pnpm install"
else
  say "running pnpm install"
  pnpm install
fi

# ── 2. .env ──
if [ -f "$ROOT/.env" ]; then
  say ".env already exists — skipping"
elif [ -f "$ROOT/.env.example" ]; then
  say "creating .env from .env.example"
  cp "$ROOT/.env.example" "$ROOT/.env"
  warn ".env created from .env.example — set BCP_TOKEN to a random value before exposing BCP_HOST beyond this machine"
else
  warn "no .env and no .env.example — leaving .env untouched (backend.sh will fall back to compiled-in defaults)"
fi

# ── 3. weclaw symlink ──
# weclaw hardcodes ~/.weclaw with no CLI flag, so the data directory must be
# either there or symlinked to the per-repo config dir. We always (re)create
# the symlink if it points at a different target — that way `git pull` + a
# `mv` of the repo doesn't leave a stale link behind.
WECLAW_HOME="${HOME}/.weclaw"
WECLAW_TARGET="$ROOT/packages/weclaw/config"
if [ ! -d "$WECLAW_TARGET" ]; then
  warn "weclaw config dir $WECLAW_TARGET does not exist — skipping symlink (only needed with BCP_WECLAW_ENABLE=1)"
elif [ -L "$WECLAW_HOME" ] && [ "$(readlink "$WECLAW_HOME")" = "$WECLAW_TARGET" ]; then
  say "~/.weclaw already points at $WECLAW_TARGET — skipping"
elif [ -e "$WECLAW_HOME" ]; then
  warn "$WECLAW_HOME exists and is not a symlink to $WECLAW_TARGET — leaving it alone (manual fix required if you want project-local config)"
else
  say "symlinking ~/.weclaw → $WECLAW_TARGET"
  ln -s "$WECLAW_TARGET" "$WECLAW_HOME"
fi

# ── 4. console data dir ──
# Refuse to provision on top of a pre-resource/ checkout. The DB and staged
# uploads are untracked, so pulling the consolidation leaves them behind at the
# old paths; pushing a fresh schema here would look like a clean install while
# every run, schedule and artifact appears to be gone. Never move data on the
# operator's behalf — say exactly what to run and stop.
if [ -f "$ROOT/packages/console/data/console.db" ]; then
  die "found a pre-resource/ database at packages/console/data/console.db.
     Move it instead of initializing on top of it:
       mkdir -p $ROOT/resource/db && mv $ROOT/packages/console/data/console.db* $ROOT/resource/db/$([ -d "$ROOT/uploads" ] && printf '\n       mv %s/uploads %s/resource/uploads' "$ROOT" "$ROOT")
     Then re-run pnpm run init."
fi
CONSOLE_DATA_DIR="$ROOT/resource/db"
if [ -d "$CONSOLE_DATA_DIR" ]; then
  say "console data dir already exists — skipping"
else
  say "creating $CONSOLE_DATA_DIR"
  mkdir -p "$CONSOLE_DATA_DIR"
fi

# ── 5. prisma migrate deploy (schema is always migrated, never `db push`-ed) ──
CONSOLE_DB="$CONSOLE_DATA_DIR/console.db"
# Schema changes go through prisma/migrations/ exclusively. `prisma migrate
# deploy` runs any pending migration.sql in order; on an empty console.db it
# bootstraps the schema from scratch via the 0_init migration (Book, Run,
# Schedule, ... are first defined there), so the `_prisma_migrations`
# bookkeeping is correct from day one. On an existing DB it only applies the
# migrations whose row isn't already in `_prisma_migrations`.
#
# Never use `prisma db push` — it writes schema.prisma straight into the DB
# without recording a migration, which on next `migrate deploy` leaves
# sqlite_master referencing columns that 0_init / payload_convergence /
# drop_derived_payload_columns then try to ALTER, producing orphan indexes
# the SQLite engine refuses to open (the corruption we hit 2026-08-29).
#
# `migrate deploy` needs the write lock, and a running console holds it. Prisma
# surfaces that as an opaque Rust backtrace ("database is locked" under
# sql_migration_persistence::initialize), so check first and say what to do.
CONSOLE_PID="$(cat "$ROOT/.console.pid" 2>/dev/null || true)"
if [ -n "$CONSOLE_PID" ] && kill -0 "$CONSOLE_PID" 2>/dev/null; then
  die "the console (pid $CONSOLE_PID) is running and holds the SQLite write lock.
     Stop the stack first, then re-run:
       pnpm kill && pnpm run init && pnpm start"
fi
if [ -f "$CONSOLE_DB" ]; then
  say "console.db already exists — applying any pending migrations"
else
  say "creating console.db via prisma migrate deploy (0_init bootstraps the schema)"
fi
(cd "$ROOT/packages/console" && DATABASE_URL="file:../../../resource/db/console.db" pnpm exec prisma migrate deploy --schema=prisma/schema.prisma)

say "regenerating prisma client"
(cd "$ROOT/packages/console" && pnpm exec prisma generate --schema=prisma/schema.prisma)

# ── 6. (optional) playwright ──
if command -v playwright >/dev/null 2>&1; then
  say "playwright is on PATH — installing chromium (skip if already cached)"
  (cd "$ROOT/packages/backend" && pnpm exec playwright install chromium || warn "playwright install failed — backend live-view tests will be skipped")
else
  say "playwright not on PATH — skipping (only required for `pnpm check:dom` and live-view manual tests)"
fi

# ── 7. (optional) local LLM runtime ──
# The provider-aware dispatcher (local-llm.sh) provisions the binary for the
# resolved profile — managed Ollama on non-Mac/low-memory hosts, the `lms` CLI
# on the Mac LM Studio profile. `ensure` starts nothing, honours BCP_LLM_ENABLE,
# and never downloads a model; it only checks the prerequisite binary.
if bash "$ROOT/packages/llm/scripts/local-llm.sh" ensure; then
  say "local LLM runtime ready (provider decided by profile)"
else
  warn "local LLM runtime not ready — with BCP_LLM_ENABLE=1, pnpm start fails until it is; remove that line from .env to skip the local LLM"
fi

say "init done — next: pnpm start"
say "pnpm start builds, starts the backend and the console, and fills a fresh database"
say "(contract registry, playbook index, the two built-in flows) — nothing to seed by hand."
say "Then load the extension, connect your agent, and run \`pnpm doctor\` to check every step."
say "Optional parts stay off until you turn them on in .env: BCP_WECLAW_ENABLE=1 (WeChat,"
say "needs Go 1.25+ and a QR login) and BCP_LLM_ENABLE=1 (local model)."
