#!/usr/bin/env bash
# Launches Grol with the agent loaded from the repo (--grol-agent-dir, patch 002),
# so extension edits apply on the next launch without a rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
APP_DIR="$HOME/Applications/Grol.app"
[ -d "$APP_DIR" ] || APP_DIR="$ENGINE_ROOT/src/out/Release/$BUILD_APP"
APP="$APP_DIR/$BUILD_BINARY"
EXT="$PWD/agent-extension"
PROFILE="${GROL_PROFILE:-$ENGINE_ROOT/grol-profile3}"

[ -x "$APP" ] || { echo "! not built yet - run scripts/build.sh"; exit 1; }

# The browser keeps a registered service worker across restarts, so edited background
# code may never run. The worker compares this content hash with its own and warns
# (checkFreshWorker in background.js); a changed hash also drops cached workers.
STAMP=$(cd "$EXT" && cat $(ls *.js *.html *.css | grep -v '^build.js$') | shasum | cut -c1-12)
/usr/bin/sed -i '' "s/^self.GROL_BUILD = .*/self.GROL_BUILD = '$STAMP';/" "$EXT/build.js"
STAMP_FILE="$PROFILE/.grol-ext-stamp"
if [ "$(cat "$STAMP_FILE" 2>/dev/null)" != "$STAMP" ]; then
  rm -rf "$PROFILE/Default/Service Worker"
  mkdir -p "$PROFILE" && echo "$STAMP" > "$STAMP_FILE"
fi

if ! curl -s -m 2 http://127.0.0.1:7777/health >/dev/null 2>&1; then
  echo "▶ OS Control helper is not running - install it with companion/install-autostart.sh"
fi

# Built without Metal (no full Xcode): use ANGLE's GL backend (patch 001). GPU
# rasterization on that backend fails in Skia (incompatible CompoundImageBacking).
GPU_FLAGS=(--use-angle=gl --disable-gpu-rasterization)
# The code-sign clone fails on ad-hoc signed local builds and only protects signed updates.
MISC_FLAGS=(--disable-features=MacAppCodeSignClone)

exec "$APP" --user-data-dir="$PROFILE" --grol-agent-dir="$EXT" --no-first-run \
  "${GPU_FLAGS[@]}" "${MISC_FLAGS[@]}" "$@"
