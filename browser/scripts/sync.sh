#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
export PATH="$HOME/depot_tools:$PATH"

command -v gclient >/dev/null || { echo "! depot_tools not on PATH ($HOME/depot_tools)"; exit 1; }

mkdir -p "$ENGINE_ROOT"
cd "$ENGINE_ROOT"

if [ ! -d src ]; then
  echo "▶ First fetch (~30-40GB, 1-3h, network bound)"
  fetch --nohooks --no-history "$FETCH_RECIPE"
fi

echo "▶ Checking out $ENGINE_REF"
git -C src fetch --depth=1 origin "$ENGINE_REF"
git -C src checkout --quiet FETCH_HEAD

echo "▶ Syncing dependencies"
gclient sync --no-history --shallow --force

echo "  ✓ Engine ready at $ENGINE_ROOT/src"
