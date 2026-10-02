#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source config/engine.conf
SRC="$ENGINE_ROOT/src"

[ -d "$SRC" ] || { echo "! no checkout - run scripts/sync.sh first"; exit 1; }

if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "! $SRC has local changes. Reset it before applying:"
  echo "    git -C $SRC checkout . && git -C $SRC clean -fd"
  exit 1
fi

applied=0
while read -r patch || [ -n "$patch" ]; do
  case "$patch" in ''|\#*) continue ;; esac
  echo "▶ $patch"
  git -C "$SRC" apply --verbose "$PWD/patches/$patch"
  applied=$((applied+1))
done < patches/series

echo "  ✓ $applied patch(es) applied"
python3 scripts/brand-strings.py "$SRC" "$UPSTREAM_NAME" "$PRODUCT_NAME"
scripts/brand-logos.sh "$SRC"
