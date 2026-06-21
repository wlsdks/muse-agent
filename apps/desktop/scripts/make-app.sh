#!/usr/bin/env bash
# Assemble a real MuseDesktop.app bundle from the SwiftPM release binary.
#
# Why a bundle (not just `swift run`): macOS TCC keys mic/speech permission to a
# bundle's CFBundleIdentifier + code signature, and HARD-CRASHES a process that
# requests them without the matching NS…UsageDescription Info.plist keys. A bare
# `swift run` binary has neither, so voice input (slice 5) needs this .app.
set -euo pipefail
cd "$(dirname "$0")/.."   # → apps/desktop

APP="Muse.app"
EXE="MuseDesktop"
BUNDLE_ID="com.muse.desktop"

echo "building release…"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/$EXE"
[ -x "$BIN" ] || { echo "release binary missing: $BIN" >&2; exit 1; }

rm -rf "$APP" "MuseDesktop.app"   # drop the old name too
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXE"

# Copy SwiftPM resource bundles (e.g. MuseDesktop_MuseDesktop.bundle carrying the
# goddess mascot image) into the app so Bundle.module resolves them at runtime.
BIN_DIR="$(swift build -c release --show-bin-path)"
for b in "$BIN_DIR"/*.bundle; do [ -e "$b" ] && cp -R "$b" "$APP/Contents/Resources/"; done

# The goddess app icon (Dock / Finder / ⌘-Tab).
[ -f AppIcon.icns ] || { echo "AppIcon.icns missing — run scripts/make-icon.sh first" >&2; exit 1; }
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# SELF-CONTAINED: compile the Muse CLI into a single binary (bun runtime baked
# in) and bundle it inside the .app, so the companion needs NO external node,
# repo, or node_modules — it works wherever the .app is moved/distributed. The
# Swift app resolves this binary relative to its bundle at runtime (MuseBridge),
# so there is no baked absolute path to break on move.
REPO="$(cd ../.. && pwd)"
[ -f "$REPO/apps/cli/dist/index.js" ] || { echo "CLI dist missing — run 'pnpm --filter @muse/cli build' first" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required to build the self-contained CLI binary (https://bun.sh)" >&2; exit 1; }
echo "building self-contained CLI binary…"
bun "$PWD/scripts/build-cli-binary.mjs" "$(cd "$APP/Contents/Resources" && pwd)/muse-cli-bin"
chmod +x "$APP/Contents/Resources/muse-cli-bin"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Muse</string>
  <key>CFBundleDisplayName</key><string>Muse</string>
  <key>CFBundleExecutable</key><string>${EXE}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Muse listens to your voice so you can ask about your notes hands-free. Audio is transcribed on-device and never leaves your Mac.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Muse turns your spoken question into text on-device. Your speech never leaves your Mac.</string>
  <key>NSHumanReadableCopyright</key><string>(c) 2026</string>
</dict>
</plist>
PLIST

# Ad-hoc sign so TCC has a code identity to attribute the grant to (a Developer
# ID signature is better for a stable grant across rebuilds; ad-hoc is fine for
# local personal use). Validate the signature — an unsigned bundle still runs
# but mic/speech (TCC) won't work, so surface that loudly rather than silently.
if codesign --force --sign - "$APP" >/dev/null 2>&1 && codesign --verify --deep "$APP" >/dev/null 2>&1; then
  echo "code-signed (ad-hoc) — mic/speech permission can be granted"
else
  echo "WARNING: codesign failed — the bundle runs, but mic/speech (voice input) won't work until it's signed" >&2
fi

# Validate the plist so a typo can't silently break TCC.
plutil -lint "$APP/Contents/Info.plist"
echo "built $APP — open it with:  open $APP"
