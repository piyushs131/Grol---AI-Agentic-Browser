#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
APP_DIR="$HOME/Applications/Grol.app"
[ -d "$APP_DIR" ] || APP_DIR="$ENGINE_ROOT/src/out/Release/$BUILD_APP"
APP="$APP_DIR/$BUILD_BINARY"
EXT="$PWD/agent-extension"
PROFILE="${GROL_PROFILE:-$ENGINE_ROOT/grol-profile3}"

[ -x "$APP" ] || { echo "! not built yet - run scripts/build.sh"; exit 1; }

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

GPU_FLAGS=(--use-angle=gl --disable-gpu-rasterization)
MISC_FLAGS=(--disable-features=MacAppCodeSignClone)

exec "$APP" --user-data-dir="$PROFILE" --grol-agent-dir="$EXT" --no-first-run \
  "${GPU_FLAGS[@]}" "${MISC_FLAGS[@]}" "$@"
