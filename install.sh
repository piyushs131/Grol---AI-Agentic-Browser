#!/usr/bin/env bash
# Installs the latest Grol release into /Applications, with OS Control.
#
#   curl -fsSL https://raw.githubusercontent.com/piyushs131/Grol---AI-Agentic-Browser/main/install.sh | bash
#
# Options (after `bash -s --` when piped):
#   --no-os-control  install only the browser, without the OS Control helper
#   --version vX.Y.Z install a specific release instead of the latest
#   --no-launch      don't open Grol when done
# GROL_ZIP=<path or URL> installs from a specific zip and GROL_INSTALL_DIR=<dir>
# installs somewhere other than /Applications (both for testing a local build).
set -euo pipefail

REPO="piyushs131/Grol---AI-Agentic-Browser"
OS_CONTROL=1
VERSION=""
LAUNCH=1

say() { printf '%s\n' "$*"; }
die() { say "! $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --os-control) OS_CONTROL=1 ;;
    --no-os-control) OS_CONTROL=0 ;;
    --version) VERSION="${2:?--version needs a tag}"; shift ;;
    --no-launch) LAUNCH=0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || die "Grol runs on macOS only."
[ "$(uname -m)" = "arm64" ] || die "Grol needs an Apple Silicon Mac (M1 or newer)."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ZIP="${GROL_ZIP:-}"
if [ -z "$ZIP" ]; then
  if [ -n "$VERSION" ]; then API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
  else API="https://api.github.com/repos/$REPO/releases/latest"; fi
  say "▶ Finding the ${VERSION:-latest} release"
  RELEASE="$(curl -fsSL "$API")" || die "couldn't find the ${VERSION:-latest} release of $REPO on GitHub."
  ZIP="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*-arm64\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/' || true)"
  [ -n "$ZIP" ] || die "no Grol-*-arm64.zip in the ${VERSION:-latest} release of $REPO."
fi

case "$ZIP" in
  http*://*)
    say "▶ Downloading $(basename "$ZIP")"
    curl -fL --progress-bar -o "$WORK/grol.zip" "$ZIP" ;;
  *) cp "$ZIP" "$WORK/grol.zip" ;;
esac

say "▶ Unpacking"
ditto -x -k "$WORK/grol.zip" "$WORK/pkg"
[ -d "$WORK/pkg/Grol.app" ] || die "the download doesn't contain Grol.app."

DEST_DIR="${GROL_INSTALL_DIR:-/Applications}"
[ -w "$DEST_DIR" ] || { DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; }
APP="$DEST_DIR/Grol.app"

if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
  say "▶ Quitting the running Grol"
  osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.5; done
  pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 && die "Grol is still running. Quit it and run this again."
fi

say "▶ Installing to $APP"
rm -rf "$APP"
ditto "$WORK/pkg/Grol.app" "$APP"
# curl downloads aren't quarantined, but a zip passed in via GROL_ZIP may be.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
say "  ✓ Grol installed (your profile and settings are kept)"

if [ "$OS_CONTROL" = 1 ]; then
  [ -x "$WORK/pkg/Install OS Control.command" ] || die "this release doesn't include the OS Control helper."
  xattr -dr com.apple.quarantine "$WORK/pkg" 2>/dev/null || true
  "$WORK/pkg/Install OS Control.command"
fi

[ "$LAUNCH" = 1 ] && open "$APP"

cat <<EOF

Next: in Grol press Command-Shift-Y, click the key icon and paste your API key
(a free Gemini key: https://aistudio.google.com/apikey).
EOF
