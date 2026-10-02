#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
BROWSER="$PWD"
REPO="$(cd .. && pwd)"
SRC_APP="$ENGINE_ROOT/src/out/Release/$BUILD_APP"
OUT="$BROWSER/dist"
STAGE="$OUT/stage"
APP="$STAGE/Grol.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$SRC_APP/Contents/Info.plist")"
INSTALLED_HELPER="$HOME/Library/Application Support/Grol/companion"

[ -d "$SRC_APP" ] || { echo "! no build - run scripts/build.sh"; exit 1; }
[ -x "$INSTALLED_HELPER/bin/node" ] || { echo "! install the helper here first (companion/install-autostart.sh): its node_modules are reused"; exit 1; }

echo "▶ Staging Grol.app"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$SRC_APP" "$APP"

RES="$(echo "$APP"/Contents/Frameworks/*Framework.framework/Versions/Current/Resources)"
rsync -a --delete --exclude '.DS_Store' "$BROWSER/agent-extension/" "$RES/grol_agent/"
"$BROWSER/scripts/stamp-agent.sh" "$RES/grol_agent"

echo "▶ Branding"
PL="$APP/Contents/Info.plist"
set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PL" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PL"; }
set_plist CrProductDirName Grol/Browser

echo "▶ OS Control helper payload"
HELPER="$STAGE/.os-control-helper"
mkdir -p "$HELPER/bin"
cp "$INSTALLED_HELPER/bin/node" "$HELPER/bin/node"
rsync -a --delete "$REPO/ai-agent-os/" "$HELPER/ai-agent-os/" --exclude .agent-os-data --exclude node_modules
rsync -a "$INSTALLED_HELPER/node_modules/" "$HELPER/node_modules/"
cp "$REPO/ai-agent-os/package.json" "$HELPER/package.json"
cp "$BROWSER/companion/daemon.js" "$HELPER/daemon.js"
cp "$BROWSER/companion/Install OS Control.command" "$STAGE/"
chmod +x "$STAGE/Install OS Control.command"

cat > "$STAGE/READ ME FIRST.txt" <<EOF
Grol $VERSION - AI browser (test build, Apple Silicon Macs: M1 or newer)

1. Drag Grol into Applications, then open it from Applications.
2. macOS will say it cannot check Grol for malicious software (this test build
   is not notarized by Apple). Click Done, then:
     System Settings > Privacy & Security > scroll down > "Grol was blocked"
     > Open Anyway > enter your Mac password > Open.
   You only do this once.
3. In Grol, click the ring icon in the toolbar to open the side panel and paste
   your own Gemini API key (free at https://aistudio.google.com/apikey).

Tabs: right-click the tab strip to switch between vertical and horizontal
tabs; right-click a tab > "Add Tab to New Group" for sections of tabs.

OS Control (optional, advanced): lets Grol open and use apps on your Mac. It
needs Accessibility and Screen Recording permission for a helper program, so
install it only if you are comfortable with that: open
"Install OS Control.command" the same way as step 2.
EOF
ln -s /Applications "$STAGE/Applications"

echo "▶ Branding and signing"
"$BROWSER/scripts/brand-app.sh" "$APP"

echo "▶ Disk image"
DMG="$OUT/Grol-$VERSION-arm64.dmg"
rm -f "$DMG"
hdiutil create -quiet -volname "Grol" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG"
if [ -n "${GROL_SIGN_ID:-}" ] && [ -n "${GROL_NOTARY_PROFILE:-}" ]; then
  codesign --sign "$GROL_SIGN_ID" --timestamp "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$GROL_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo "▶ Zip for install.sh"
ZIP="$OUT/Grol-$VERSION-arm64.zip"
rm -f "$ZIP" "$STAGE/Applications"
ditto -c -k --sequesterRsrc "$STAGE" "$ZIP"
rm -rf "$STAGE"
echo "  ✓ $DMG ($(du -h "$DMG" | cut -f1))"
echo "  ✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
