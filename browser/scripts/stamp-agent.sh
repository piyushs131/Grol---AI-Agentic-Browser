#!/usr/bin/env bash
set -euo pipefail
DIR="${1:?usage: stamp-agent.sh <agent dir>}"
VERSION="0.$(date -u +%y).$((10#$(date -u +%j))).$((10#$(date -u +%H%M)))"
STAMP="$(cd "$DIR" && find . -type f ! -name build.js ! -name .DS_Store | LC_ALL=C sort | xargs cat | shasum | cut -c1-12)"
WORKER="background-$STAMP.js"
rm -f "$DIR"/background-*.js
mv "$DIR/background.js" "$DIR/$WORKER"
/usr/bin/python3 - "$DIR/manifest.json" "$VERSION" "$WORKER" <<'PY'
import json, sys
path, version, worker = sys.argv[1:]
manifest = json.load(open(path))
manifest['version'] = version
manifest['background']['service_worker'] = worker
json.dump(manifest, open(path, 'w'), indent=2)
open(path, 'a').write('\n')
PY
/usr/bin/sed -i '' "s/^self.GROL_BUILD = .*/self.GROL_BUILD = '$STAMP';/" "$DIR/build.js"
echo "  ✓ agent version $VERSION"
