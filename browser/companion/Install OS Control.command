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
rsync -a --exclude /logs --exclude '.agent-os-data' \
  $( [ -x "$DEST/bin/node" ] && echo "--exclude /bin/node" ) "$SRC/" "$DEST/"
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

desktop() {
  curl -s -m 10 -X POST http://127.0.0.1:7777/execute -H 'content-type: application/json' \
    -d "{\"task_id\":\"install\",\"module\":\"desktop\",\"action\":\"$1\",\"parameters\":{}}" 2>/dev/null || true
}
granted() { desktop getPermissions | grep -q "\"$1\":true"; }

if granted accessibility && granted screenRecording; then
  say "✓ OS Control already has Accessibility and Screen Recording permission."
  exit 0
fi

# Asking macOS for the permissions adds "node" to both lists, so the user only
# has to flip the switches on the pages we open.
desktop requestPermissions >/dev/null
printf '%s' "$NODE" | pbcopy
pane() { open "x-apple.systempreferences:com.apple.preference.security?Privacy_$1"; }

cat <<EOF

────────────────────────────────────────────────────────────
 Last step: allow OS Control
────────────────────────────────────────────────────────────
 System Settings will open. Just turn ON the switch next to
 "node" — first under Accessibility, then under Screen Recording.
 Nothing else to type or run; this window finishes by itself.
────────────────────────────────────────────────────────────
EOF

# Permissions are checked in fresh processes, so they show up here as soon as
# the user switches them on. Restart once at the end so the helper starts clean.
ax=0; sr=0
granted accessibility && { ax=1; say "  ✓ Accessibility already on"; }
if [ $ax = 1 ]; then pane ScreenCapture; else pane Accessibility; fi
for i in $(seq 1 300); do
  if [ $ax = 0 ] && granted accessibility; then
    ax=1; say "  ✓ Accessibility on"
    [ $sr = 0 ] && pane ScreenCapture
  fi
  if [ $sr = 0 ] && granted screenRecording; then sr=1; say "  ✓ Screen Recording on"; fi
  [ $ax = 1 ] && [ $sr = 1 ] && break
  if [ "$i" = 30 ]; then
    say "  Don't see \"node\" in the list? Click +, press Command-Shift-G, press"
    say "  Command-V (the path is already copied), press Return, then click Open."
  fi
  sleep 2
done

if [ $ax = 1 ] && [ $sr = 1 ]; then
  launchctl kickstart -k "gui/$UID_/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do curl -s -m 1 http://127.0.0.1:7777/health >/dev/null 2>&1 && break; sleep 0.5; done
  say "✓ OS Control is ready."
else
  say "  Still waiting? No need to run anything else: Grol picks up the permissions"
  say "  as soon as you turn on \"node\" under Accessibility and Screen Recording."
fi
