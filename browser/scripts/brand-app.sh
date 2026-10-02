#!/usr/bin/env bash
set -euo pipefail
APP="${1:?usage: brand-app.sh <App.app>}"
BROWSER="$(cd "$(dirname "$0")/.." && pwd)"
PL="$APP/Contents/Info.plist"

set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PL"; }
set_plist CFBundleName Grol
set_plist CFBundleDisplayName Grol

WORK="$(mktemp -d)"
ICONSET="$WORK/grol.iconset"; mkdir -p "$ICONSET"
qlmanage -t -s 1024 -o "$WORK" "$BROWSER/agent-extension/icon-tile.svg" >/dev/null 2>&1 || true
[ -f "$WORK/icon-tile.svg.png" ] || { echo "! could not render the app icon (qlmanage)"; exit 1; }
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon-tile.svg.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$WORK/icon-tile.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/app.icns"
rm -rf "$WORK"
set_plist CFBundleIconFile app.icns
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PL" 2>/dev/null || true

ID="${GROL_SIGN_ID:-}"
if [ -n "$ID" ]; then
  echo "  signing with: $ID"
  codesign --force --deep --options runtime --timestamp --sign "$ID" "$APP"
else
  echo "  signing ad-hoc"
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep "$APP"

touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
