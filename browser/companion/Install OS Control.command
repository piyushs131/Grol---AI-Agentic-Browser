#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/.os-control-helper"
DEST="$HOME/Library/Application Support/Grol/companion"
LABEL="com.grol.os-companion"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_="$(id -u)"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$DEST"
  say "✓ OS Control helper removed."
  exit 0
fi

[ -d "$SRC" ] || { say "! Can't find the helper files next to this installer. Run it from the Grol disk image."; exit 1; }
[ "$(uname -m)" = "arm64" ] || { say "! This build of Grol needs an Apple Silicon Mac (M1 or newer)."; exit 1; }

say "▶ Installing the Grol OS Control helper…"
mkdir -p "$DEST/logs" "$HOME/Library/LaunchAgents"
rsync -a --exclude logs --exclude '.agent-os-data' \
  $( [ -x "$DEST/bin/node" ] && echo "--exclude bin/node" ) "$SRC/" "$DEST/"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

NODE="$DEST/bin/node"
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

launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1 || break; sleep 0.25; done
launchctl bootstrap "gui/$UID_" "$PLIST"

for _ in $(seq 1 20); do
  curl -s -m 1 http://127.0.0.1:7777/health >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -s -m 2 http://127.0.0.1:7777/health >/dev/null 2>&1; then
  say "! The helper did not start. Details: $DEST/logs/companion.err"
  exit 1
fi
say "✓ Helper running (starts automatically at login)."

curl -s -m 10 -X POST http://127.0.0.1:7777/execute -H 'content-type: application/json' \
  -d '{"task_id":"install","module":"desktop","action":"requestPermissions","parameters":{}}' >/dev/null 2>&1 || true
printf '%s' "$NODE" | pbcopy
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

cat <<EOF

────────────────────────────────────────────────────────────
 One last step: let OS Control use your Mac
────────────────────────────────────────────────────────────
 In System Settings → Privacy & Security, turn this file ON under
 BOTH "Accessibility" and "Screen Recording":

   $NODE

 (The path is on your clipboard: click +, press Command-Shift-G,
  paste, press Return, click Open.)

 Then restart the helper:
   launchctl kickstart -k gui/$UID_/$LABEL
────────────────────────────────────────────────────────────
EOF
