#!/bin/bash
# One-time setup for automatic updates on a Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/larrypro1234/liquidation-scanner/main/install-mac.sh | bash
#
# Puts the extension in ~/liquidation-scanner and installs a small background
# job that downloads the latest version from GitHub every 5 minutes. The
# extension notices the new files and reloads itself. Run it again any time;
# it's safe to repeat. To remove the job:
#   launchctl bootout gui/$(id -u)/com.liquidation-scanner.updater; rm ~/Library/LaunchAgents/com.liquidation-scanner.updater.plist

set -euo pipefail

EXT_DIR="${LIQ_EXT_DIR:-$HOME/liquidation-scanner}"
SUPPORT_DIR="$HOME/Library/Application Support/LiquidationScanner"
UPDATER="$SUPPORT_DIR/update.sh"
LABEL="com.liquidation-scanner.updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$SUPPORT_DIR"

cat > "$UPDATER" <<'UPDATER_EOF'
#!/bin/bash
# Downloads the latest scanner and swaps it into place if the version changed.
set -euo pipefail
EXT_DIR="${LIQ_EXT_DIR:-$HOME/liquidation-scanner}"
ZIP_URL="https://github.com/larrypro1234/liquidation-scanner/raw/main/dist/liquidation-scanner.zip"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$ZIP_URL?t=$(date +%s)" -o "$TMP/scanner.zip"
unzip -q "$TMP/scanner.zip" -d "$TMP"
NEW="$TMP/liquidation-scanner"
[ -f "$NEW/manifest.json" ] || { echo "download looks wrong, skipping"; exit 1; }

version() { grep -m1 '"version"' "$1" 2>/dev/null | sed 's/[^0-9.]//g'; }
if [ -f "$EXT_DIR/manifest.json" ] && [ "$(version "$NEW/manifest.json")" = "$(version "$EXT_DIR/manifest.json")" ]; then
  exit 0
fi

mkdir -p "$EXT_DIR"
# Copy everything except the manifest first, then the manifest: the extension
# reloads when it sees the new version number, so the rest must already be there.
for f in "$NEW"/* "$NEW"/.[!.]*; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = "manifest.json" ] && continue
  rm -rf "$EXT_DIR/$(basename "$f")"
  cp -R "$f" "$EXT_DIR/"
done
cp "$NEW/manifest.json" "$EXT_DIR/manifest.json.new"
mv "$EXT_DIR/manifest.json.new" "$EXT_DIR/manifest.json"
echo "$(date): updated to $(version "$EXT_DIR/manifest.json")"
UPDATER_EOF
chmod +x "$UPDATER"

echo "Downloading the scanner into $EXT_DIR ..."
"$UPDATER"

if [ "${LIQ_SKIP_LAUNCHD:-}" = "1" ]; then exit 0; fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$UPDATER</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$SUPPORT_DIR/update.log</string>
  <key>StandardErrorPath</key><string>$SUPPORT_DIR/update.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo
echo "✅ Auto-updates are on."
echo "   Scanner folder: $EXT_DIR"
echo "   In Chrome: chrome://extensions → Load unpacked → pick the 'liquidation-scanner' folder in your home folder."
