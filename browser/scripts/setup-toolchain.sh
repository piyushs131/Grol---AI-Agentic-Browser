#!/usr/bin/env bash
# Lets the engine build against Command Line Tools instead of full Xcode.
# The build needs Xcode only to read Contents/version.plist (via --developer_dir, which
# use_system_xcode=false passes) and to find SDKs in Xcode's nested layout. A directory
# with a version.plist and symlinks into CLT satisfies both. Unsupported upstream:
# suspect this first if a compile fails for no clear reason.
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
SRC="$ENGINE_ROOT/src"
CLT="$(xcode-select -p)"

[ -d "$SRC" ] || { echo "! no checkout - run scripts/sync.sh first"; exit 1; }
[ -x "$CLT/usr/bin/clang" ] || { echo "! no clang at $CLT - run: xcode-select --install"; exit 1; }

# The SDK the engine will compile against. Newest CLT SDK that is not the bare
# symlink, so the version is explicit rather than whatever MacOSX.sdk points at.
SDK_NAME="$(ls "$CLT/SDKs" 2>/dev/null | grep -E '^MacOSX[0-9]+\.?[0-9]*\.sdk$' | sort -V | tail -1 || true)"
[ -n "$SDK_NAME" ] || { echo "! no macOS SDK under $CLT/SDKs"; exit 1; }

XB="$SRC/build/mac_files/xcode_binaries"
rm -rf "$XB"
mkdir -p "$XB/Contents/Developer/Platforms/MacOSX.platform/Developer"

# The pinned engine asserts xcode_version >= 2600. Report the CLT's own SDK version,
# which is the thing actually being compiled against.
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
# The build looks for tools at Xcode's exact toolchain path:
#   $dev/Toolchains/XcodeDefault.xctoolchain/usr/bin/   (build/config/mac/mac_sdk.gni)
# gperf, bison and flex all live there, and CLT keeps them in plain usr/bin -
# so the xctoolchain level has to be recreated or the build dies looking for
# gperf before it compiles a single file.
mkdir -p "$XB/Contents/Developer/Toolchains/XcodeDefault.xctoolchain"
ln -sfn "$CLT/usr" "$XB/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr"
ln -sfn "$CLT/SDKs"    "$XB/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs"

echo "  ✓ toolchain shim ready (CLT: $CLT, SDK: $SDK_NAME)"
echo "    build.sh will use: use_system_xcode=false, mac_sdk_path=$CLT/SDKs/$SDK_NAME"
# Record it so build.sh uses the same SDK without re-deriving it.
echo "$CLT/SDKs/$SDK_NAME" > config/.sdk_path
