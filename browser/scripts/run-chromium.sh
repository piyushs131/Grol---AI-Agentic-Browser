#!/usr/bin/env bash
# Runs the Grol Agent in a stock Chromium build: no engine build needed.
# Downloads an official Chromium snapshot once, then launches it with the agent
# loaded from agent-extension/. You get the agent, side panel and ad blocking;
# the browser-level patches (branding, theme, tab defaults) are not applied.
#
#   GROL_CHROMIUM_REV=<n>   use this snapshot revision instead of the latest
#   GROL_CHROMIUM_DIR=<dir> where to keep the download
#   GROL_PROFILE=<dir>      browser profile folder
#   --update                fetch a newer snapshot
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac_Arm"
DIR="${GROL_CHROMIUM_DIR:-$HOME/Library/Application Support/Grol/chromium}"
APP="$DIR/chrome-mac/Chromium.app"
EXT="$PWD/agent-extension"
PROFILE="${GROL_PROFILE:-$DIR/profile}"

[ "$(uname -m)" = "arm64" ] || { echo "! needs an Apple Silicon Mac"; exit 1; }

if [ "${1:-}" = "--update" ]; then rm -rf "$DIR/chrome-mac"; shift; fi

if [ ! -x "$APP/Contents/MacOS/Chromium" ]; then
  REV="${GROL_CHROMIUM_REV:-$(curl -fsSL "$BASE/LAST_CHANGE")}"
  echo "▶ Downloading Chromium snapshot $REV (~180 MB, once)"
  mkdir -p "$DIR"
  curl -fL --progress-bar -o "$DIR/chrome-mac.zip" "$BASE/$REV/chrome-mac.zip"
  rm -rf "$DIR/chrome-mac"
  ditto -x -k "$DIR/chrome-mac.zip" "$DIR"
  rm -f "$DIR/chrome-mac.zip"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
fi

if ! curl -s -m 2 http://127.0.0.1:7777/health >/dev/null 2>&1; then
  echo "▶ OS Control helper is not running - install it with companion/install-autostart.sh"
fi

exec "$APP/Contents/MacOS/Chromium" --user-data-dir="$PROFILE" --no-first-run \
  --load-extension="$EXT" --silent-debugger-extension-api \
  --disable-features=DisableLoadExtensionCommandLineSwitch "$@"
