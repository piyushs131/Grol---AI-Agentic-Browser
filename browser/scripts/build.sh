#!/usr/bin/env bash
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

use_system_xcode = false
mac_sdk_path = "$SDK"

angle_enable_metal = false
GN

echo "▶ Generating build files"
gn gen "$OUT"

JOBS="${JOBS:-6}"
echo "▶ Building with -j$JOBS (first build: 3-5h; incremental: minutes)"
autoninja -j"$JOBS" -C "$OUT" chrome

APP="$SRC/$OUT/$BUILD_APP"
RES="$(echo "$APP"/Contents/Frameworks/*Framework.framework/Versions/Current/Resources)"
rsync -a --delete --exclude '.DS_Store' "$OLDPWD/agent-extension/" "$RES/grol_agent/"
"$OLDPWD/scripts/stamp-agent.sh" "$RES/grol_agent"
INSTALLED="$HOME/Applications/Grol.app"
mkdir -p "$HOME/Applications"
rsync -a --delete "$APP/" "$INSTALLED/"
"$OLDPWD/scripts/brand-app.sh" "$INSTALLED"
APP="$INSTALLED"

echo "  ✓ Built $APP"
