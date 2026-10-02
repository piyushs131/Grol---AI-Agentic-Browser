#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
SRC="$ENGINE_ROOT/src"
CLT="$(xcode-select -p)"

[ -d "$SRC" ] || { echo "! no checkout - run scripts/sync.sh first"; exit 1; }
[ -x "$CLT/usr/bin/clang" ] || { echo "! no clang at $CLT - run: xcode-select --install"; exit 1; }

SDK_NAME="$(ls "$CLT/SDKs" 2>/dev/null | grep -E '^MacOSX[0-9]+\.?[0-9]*\.sdk$' | sort -V | tail -1 || true)"
[ -n "$SDK_NAME" ] || { echo "! no macOS SDK under $CLT/SDKs"; exit 1; }

XB="$SRC/build/mac_files/xcode_binaries"
rm -rf "$XB"
mkdir -p "$XB/Contents/Developer/Platforms/MacOSX.platform/Developer"

cat > "$XB/Contents/version.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key><string>26.0</string>
  <key>ProductBuildVersion</key><string>26A1000</string>
</dict>
</plist>
PLIST

ln -sfn "$CLT/usr"     "$XB/Contents/Developer/usr"
ln -sfn "$CLT/Library" "$XB/Contents/Developer/Library"
mkdir -p "$XB/Contents/Developer/Toolchains/XcodeDefault.xctoolchain"
ln -sfn "$CLT/usr" "$XB/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr"
ln -sfn "$CLT/SDKs"    "$XB/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs"

echo "  ✓ toolchain shim ready (CLT: $CLT, SDK: $SDK_NAME)"
echo "    build.sh will use: use_system_xcode=false, mac_sdk_path=$CLT/SDKs/$SDK_NAME"
echo "$CLT/SDKs/$SDK_NAME" > config/.sdk_path
