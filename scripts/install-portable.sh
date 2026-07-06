#!/usr/bin/env bash
#
# Install the `portable` CLI on macOS / Linux (PRD: tasks/prd-portable-distribution.md).
# Ensures Bun is present, ensures Bun's global-bin dir is on your PATH, then
# `bun install -g` the CLI — hardened against the failure modes a fresh dev machine
# hits (a stalled npm-registry connection, a running `portable`, a half-written
# prior install).
#
#   Run a downloaded copy:   bash scripts/install-portable.sh [source]
#   Or one-liner:            curl -fsSL <hosted-url>/install-portable.sh | bash
#                            (uses $PORTABLE_INSTALL_SOURCE for the source)
#
# `source` is any npm spec / tarball path / git url. With NO source given:
#   - Run from inside the repo checkout → it BUILDS a local artifact and installs
#     that (useful for testing local changes before they are published).
#   - Run anywhere else (e.g. the hosted one-liner) → it installs the published
#     package `@volter-ai/portable.dev`.
#
# Reliability features (no silent hangs on other people's machines):
#  - Resolves the just-installed Bun explicitly (no dependence on a PATH refresh).
#  - Refuses to install while `portable` is RUNNING (it holds the global store open),
#    with guidance — instead of stalling.
#  - Runs the install under an INACTIVITY watchdog: a stalled registry connection is
#    detected within ~a minute and retried, instead of hanging forever. Uses
#    `--prefer-offline` so warm-cache reinstalls skip registry-revalidation chatter.
#  - Classifies a NON-transient failure (e.g. a 404 not-found) and stops with the
#    real error instead of retrying it as if it were a network blip.
#  - Verifies the installed shim actually RESOLVES (catches an orphaned shim).
#
# Linux note: the in-chat browser (Playwright/Chromium) auto-downloads, but a bare
# Debian/Ubuntu box may need its system libs once:  playwright install-deps chromium
set -euo pipefail

# An explicit source (arg or env) is honored as-is; otherwise we decide below
# (local build inside a checkout, else the published package).
EXPLICIT_SOURCE="${1:-${PORTABLE_INSTALL_SOURCE:-}}"

# Where this script lives → the repo root (when run from a checkout). Guarded so the
# `curl | bash` one-liner (no real file on disk) simply falls through to the package.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
REPO_ROOT="$([ -n "${SCRIPT_DIR:-}" ] && cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"

BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="$BUN_INSTALL/bin"
GLOBAL_MODULES="$BUN_INSTALL/install/global/node_modules"
PKG_DIR="$GLOBAL_MODULES/@volter-ai/portable.dev"

# Resolve a usable bun binary even right after a fresh install (the current shell's
# PATH may not be live yet).
resolve_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  if [ -x "$BUN_BIN/bun" ]; then echo "$BUN_BIN/bun"; return 0; fi
  return 1
}

# PIDs of any running `portable` (global shim's bun children under
# .../@volter-ai/portable.dev/{cli,server}.js, or a source-mode dev run). Excludes
# this installer's own `bun install -g @volter-ai/portable.dev`.
running_portable_pids() {
  ps axo pid=,command= 2>/dev/null | awk '
    /portable\.dev\/(cli|server)\.js|packages\/launcher\/.*(start|connect)|packages\/api\/src\/server/ { print $1 }
  ' || true
}

# Build a local install artifact from this checkout and echo its tarball path on
# stdout (all build/pack chatter goes to stderr so the captured stdout is JUST the
# path). Installing the packed .tgz — not the dist dir — is load-bearing: a global
# install of the dir can't resolve its deps (its real path sits inside the monorepo,
# whose node_modules don't hold the CLI's externals).
build_local_artifact() {
  local bun="$1"
  echo "[portable] No source given; building a local artifact from this checkout (one-time, ~30s)..." >&2
  ( cd "$REPO_ROOT" && "$bun" run build:portable ) >&2 || return 1
  ( cd "$REPO_ROOT/dist-portable" && "$bun" pm pack ) >&2 || return 1
  local tgz
  tgz="$(ls -1t "$REPO_ROOT"/dist-portable/*.tgz 2>/dev/null | head -1)"
  [ -n "$tgz" ] || return 1
  printf '%s\n' "$tgz"
}

# Run one `bun install -g` attempt under an inactivity watchdog, capturing output to
# $logf. Progress is gauged by new top-level packages landing in the global store; if
# none appear for STALL_SEC, the attempt is a stalled registry connection and is
# killed so we retry. Returns 0 on success, non-zero otherwise.
install_attempt() {
  local bun="$1" logf="$2" stall="${3:-60}" cap="${4:-600}"
  "$bun" install -g "$SOURCE" --prefer-offline >"$logf" 2>&1 &
  local pid=$!
  local last_count=-1 last_progress=$SECONDS start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    kill -0 "$pid" 2>/dev/null || break
    local count
    # `(ls || true)` so a not-yet-created global dir (fresh machine, pre-extraction)
    # can't trip set -e via the command substitution.
    count=$( (ls -1 "$GLOBAL_MODULES" 2>/dev/null || true) | wc -l | tr -d ' ')
    if [ "$count" != "$last_count" ]; then last_progress=$SECONDS; last_count=$count; fi
    local idle=$(( SECONDS - last_progress )) elapsed=$(( SECONDS - start ))
    if [ "$idle" -ge "$stall" ]; then
      echo "[portable] install stalled (~${idle}s with no progress) — terminating this attempt..."
      kill -TERM "$pid" 2>/dev/null || true; sleep 2; kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    if [ "$elapsed" -ge "$cap" ]; then
      echo "[portable] install exceeded the ${cap}s cap — terminating this attempt..."
      kill -TERM "$pid" 2>/dev/null || true; sleep 2; kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
  done
  wait "$pid"
}

# A registry/resolution failure that retrying can't fix (the package genuinely isn't
# there, or a path/permission error) — vs a transient network stall worth retrying.
# NB: DependencyLoop is deliberately NOT here — it's recoverable by dropping a stale
# global self-pin (handled in the install loop), so it must not hard-fail.
is_non_transient_failure() {
  grep -qiE '404|E404|not found|no matching version|EACCES|ENOENT' "$1"
}

# Is $SOURCE a LOCAL artifact (tarball/path/git) rather than the published npm spec?
# Local installs are the ones that can hit DependencyLoop when a prior install pinned
# a different tarball path, so we proactively clear the self-pin for them.
is_local_source() {
  case "$SOURCE" in
    @volter-ai/portable.dev|@volter-ai/portable.dev@*) return 1 ;;
    *) return 0 ;;
  esac
}

# 1) Ensure Bun (its installer also wires ~/.bun/bin into your shell rc).
if ! resolve_bun >/dev/null 2>&1; then
  echo "[portable] Bun not found - installing via the official installer..."
  curl -fsSL https://bun.sh/install | bash
fi
BUN="$(resolve_bun || true)"
if [ -z "${BUN:-}" ]; then
  echo "[portable] Bun is required but could not be found or installed. Install it from https://bun.sh and re-run." >&2
  exit 1
fi
case ":$PATH:" in
  *":$BUN_BIN:"*) ;;
  *) export PATH="$BUN_BIN:$PATH" ;;
esac
echo "[portable] Using bun: $BUN ($("$BUN" --version))"

# 2) Persist Bun's global-bin dir to a shell rc if nothing references it yet (covers
#    package-manager Bun installs that skipped PATH wiring). Idempotent.
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -e "$rc" ] || continue
  if ! grep -qs '\.bun/bin' "$rc"; then
    printf '\n# Bun global bin (portable)\nexport PATH="%s:$PATH"\n' "$BUN_BIN" >>"$rc"
    echo "[portable] Added $BUN_BIN to PATH in $rc"
  fi
done

# 3) Refuse to install over a RUNNING portable (it holds the global store open;
#    an in-place reinstall could stall). Abort cleanly with guidance.
RUNNING="$(running_portable_pids | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$RUNNING" ]; then
  echo "" >&2
  echo "[portable] ERROR: 'portable' is currently running (PID(s): $RUNNING)." >&2
  echo "[portable] Stop it first (Ctrl-C in its terminal, or: kill $RUNNING), then re-run this installer." >&2
  exit 1
fi

# 4) Decide the install source (needs Bun for the local build):
#      explicit arg/env  →  honored as-is
#      inside a checkout →  build a local artifact from your working tree
#      otherwise         →  the published package (the hosted one-liner case)
if [ -n "$EXPLICIT_SOURCE" ]; then
  SOURCE="$EXPLICIT_SOURCE"
elif [ -n "${REPO_ROOT:-}" ] && [ -f "$REPO_ROOT/scripts/build-portable.ts" ]; then
  SOURCE="$(build_local_artifact "$BUN")" || {
    echo "[portable] Local build failed. Run 'bun install' then 'bun run build:portable' to see why, and re-run." >&2
    exit 1
  }
else
  SOURCE="@volter-ai/portable.dev"
fi

# 5) Install the CLI with retries + the inactivity watchdog.
echo "[portable] Installing from: $SOURCE"
echo "[portable] (first install on a fresh machine fetches dependencies — this can take a minute)"
LOGF="$(mktemp 2>/dev/null || echo "/tmp/portable-install.$$.log")"
trap 'rm -f "$LOGF"' EXIT
# Local-tarball installs: a prior install may pin a DIFFERENT tarball path in the
# global store, which makes `bun add` of the new path fail with DependencyLoop.
# Proactively drop any stale self-pin first (a no-op on a fresh machine).
if is_local_source; then
  "$BUN" remove -g @volter-ai/portable.dev >/dev/null 2>&1 || true
fi
ok=0
for attempt in 1 2 3; do
  [ "$attempt" -gt 1 ] && echo "[portable] retrying install (attempt $attempt/3)..."
  if install_attempt "$BUN" "$LOGF"; then ok=1; break; fi
  # A stale global self-pin (different tarball path) loops — clear it and retry
  # rather than treating it as a hard failure.
  if grep -qiE 'DependencyLoop' "$LOGF"; then
    echo "[portable] clearing a stale global package pin and retrying..."
    "$BUN" remove -g @volter-ai/portable.dev >/dev/null 2>&1 || true
    continue
  fi
  # A 404 / not-found / perms error won't be fixed by retrying — stop now with the
  # real error instead of three rounds mislabeled as "flaky network".
  if is_non_transient_failure "$LOGF"; then
    echo "" >&2
    echo "[portable] Install failed and retrying won't help. The error from bun was:" >&2
    sed 's/^/[portable]   /' "$LOGF" | tail -12 >&2
    if grep -qiE '404|E404|not found' "$LOGF"; then
      echo "" >&2
      echo "[portable] '$SOURCE' was not found in the npm registry." >&2
      echo "[portable] npm install failed — install from a checkout instead:" >&2
      echo "[portable]   git clone <repo> && cd mobile-vgit && bun install && scripts/install-portable.sh" >&2
      echo "[portable] (run with no source, from inside the repo, and it builds + installs a local artifact)." >&2
      echo "[portable] Or point it at a built tarball:  PORTABLE_INSTALL_SOURCE=./dist-portable/*.tgz scripts/install-portable.sh" >&2
    fi
    exit 1
  fi
done
if [ "$ok" -ne 1 ]; then
  echo "" >&2
  echo "[portable] Install did not complete after several attempts (looks like a stalled connection)." >&2
  echo "[portable] Last output from bun:" >&2
  sed 's/^/[portable]   /' "$LOGF" | tail -12 >&2
  echo "[portable] Try again on a stable connection, or run it manually to see the error:" >&2
  echo "[portable]   \"$BUN\" install -g $SOURCE --prefer-offline" >&2
  exit 1
fi

# 6) Verify: the shim exists AND its target module actually resolves (an interrupted
#    prior install can leave an ORPHANED shim pointing at a missing package).
if [ -e "$PKG_DIR/cli.js" ] && { command -v portable >/dev/null 2>&1 || [ -x "$BUN_BIN/portable" ]; }; then
  if command -v portable >/dev/null 2>&1; then
    echo "[portable] OK - installed. Run: portable"
  else
    echo "[portable] OK - installed to $BUN_BIN. Restart your shell (or 'source' your rc), then run: portable"
  fi
elif [ -x "$BUN_BIN/portable" ]; then
  echo "[portable] Install finished but the package entry is missing ($PKG_DIR/cli.js)." >&2
  echo "[portable] The shim is orphaned. Re-run this installer (the retry will materialize it)." >&2
  exit 1
else
  echo "[portable] Install finished but the portable shim was not found." >&2
  exit 1
fi
