#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
SRC="$PWD"
REPO="$(cd ../.. && pwd)"
DEST="$HOME/Library/Application Support/Grol/companion"
LABEL="com.grol.os-companion"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(node -p process.execPath 2>/dev/null || true)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$DEST"
  echo "  ✓ removed"
  exit 0
fi

[ -n "$NODE" ] || { echo "! Node.js 20 or newer is required: https://nodejs.org"; exit 1; }
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "! Node.js 20 or newer is required (found $("$NODE" -v))"; exit 1; }

echo "▶ installing to $DEST"
mkdir -p "$DEST/logs" "$DEST/bin"

if [ ! -x "$DEST/bin/node" ]; then
  cp "$NODE" "$DEST/bin/node"
fi
NODE="$DEST/bin/node"
export PATH="$DEST/bin:$PATH"
rsync -a --delete --exclude node_modules --exclude .agent-os-data "$REPO/ai-agent-os/" "$DEST/ai-agent-os/"
cp "$SRC/daemon.js" "$DEST/daemon.js"
cp "$REPO/ai-agent-os/package.json" "$DEST/package.json"

echo "▶ installing dependencies (first run takes a minute)"
( cd "$DEST" && npm install --omit=dev --no-audit --no-fund >"$DEST/logs/npm-install.log" 2>&1 ) || {
  echo "! npm install failed - see $DEST/logs/npm-install.log"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DEST/daemon.js</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/logs/companion.log</string>
  <key>StandardErrorPath</key><string>$DEST/logs/companion.err</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo "▶ waiting for it to come up"
for i in $(seq 1 15); do
  if curl -s -m 2 http://127.0.0.1:7777/health >/dev/null 2>&1; then
    echo "  ✓ OS Control helper is running (starts automatically at login)"
    echo "    For control of other apps, turn on BOTH for this file in System Settings →"
    echo "    Privacy & Security → Accessibility and → Screen Recording:"
    echo "      $NODE"
    exit 0
  fi
  sleep 1
done
echo "  ! not responding - check $DEST/logs/companion.err"
exit 1
