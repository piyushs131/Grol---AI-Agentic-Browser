#!/usr/bin/env bash
# Builds the engine with the Grol patches and installs it as ~/Applications/Grol.app.
# GN args are tuned for 16GB RAM, where linking is the memory limit (symbol_level=0, no thin LTO).
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
SRC="$ENGINE_ROOT/src"
OUT="${1:-out/Release}"
export PATH="$HOME/depot_tools:$PATH"

[ -d "$SRC" ] || { echo "! no checkout - run scripts/sync.sh first"; exit 1; }
OLDPWD="$PWD"
cd "$SRC"

mkdir -p "$OUT"
[ -f "$OLDPWD/config/.sdk_path" ] || "$OLDPWD/scripts/setup-toolchain.sh"
SDK="$(cat "$OLDPWD/config/.sdk_path")"

cat > "$OUT/args.gn" <<GN
is_debug = false
is_official_build = false
symbol_level = 0
blink_symbol_level = 0
is_component_build = false
use_thin_lto = false

# Command Line Tools instead of full Xcode (see scripts/setup-toolchain.sh).
use_system_xcode = false
mac_sdk_path = "$SDK"

# Metal shaders need the metal compiler, which only ships with full Xcode.
angle_enable_metal = false
GN

echo "▶ Generating build files"
gn gen "$OUT"

# More jobs than this runs a 16GB machine out of memory.
JOBS="${JOBS:-6}"
echo "▶ Building with -j$JOBS (first build: 3-5h; incremental: minutes)"
autoninja -j"$JOBS" -C "$OUT" chrome

# Patch 002 loads the built-in agent from the framework's Resources/grol_agent.
APP="$SRC/$OUT/$BUILD_APP"
RES="$(echo "$APP"/Contents/Frameworks/*Framework.framework/Versions/Current/Resources)"
rsync -a --delete --exclude '.DS_Store' "$OLDPWD/agent-extension/" "$RES/grol_agent/"
# Finder and the Dock show the bundle's file name, so install a copy named Grol.app.
INSTALLED="$HOME/Applications/Grol.app"
mkdir -p "$HOME/Applications"
rsync -a --delete "$APP/" "$INSTALLED/"
"$OLDPWD/scripts/brand-app.sh" "$INSTALLED"
APP="$INSTALLED"

echo "  ✓ Built $APP"
