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
REPO="$(cd ../.. && pwd)"
METADATA_VERIFIER="$PWD/scripts/verify-app-metadata.mjs"
VERSION="$(node "$METADATA_VERIFIER" --field version)"
BUILD_NUMBER="$(node "$METADATA_VERIFIER" --field build-number)"
MINIMUM_SYSTEM_VERSION="$(node "$METADATA_VERIFIER" --field minimum-system-version)"

echo "building release…"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/$EXE"
[ -x "$BIN" ] || { echo "release binary missing: $BIN" >&2; exit 1; }

rm -rf "$APP" "MuseDesktop.app"   # drop the old name too
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXE"

# Copy SwiftPM resource bundles (e.g. MuseDesktop_MuseDesktop.bundle carrying the
# bluebird mascot image) into the app so Bundle.module resolves them at runtime.
BIN_DIR="$(swift build -c release --show-bin-path)"
for b in "$BIN_DIR"/*.bundle; do [ -e "$b" ] && cp -R "$b" "$APP/Contents/Resources/"; done

# The bluebird app icon (Dock / Finder / ⌘-Tab).
[ -f AppIcon.icns ] || { echo "AppIcon.icns missing — run scripts/make-icon.sh first" >&2; exit 1; }
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# SELF-CONTAINED: compile the Muse CLI into a single binary (bun runtime baked
# in) and bundle it inside the .app, so the companion needs NO external node,
# repo, or node_modules — it works wherever the .app is moved/distributed. The
# Swift app resolves this binary relative to its bundle at runtime (MuseBridge),
# so there is no baked absolute path to break on move.
[ -f "$REPO/apps/cli/dist/index.js" ] || { echo "CLI dist missing — run 'pnpm --filter @muse/cli build' first" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required to build the self-contained CLI binary (https://bun.sh)" >&2; exit 1; }
echo "building self-contained CLI binary…"
bun "$PWD/scripts/build-cli-binary.mjs" "$(cd "$APP/Contents/Resources" && pwd)/muse-cli-bin"
chmod +x "$APP/Contents/Resources/muse-cli-bin"

# SELF-CONTAINED FULL APP: bundle the API server (compiled to a single binary)
# plus the built web UI, so "Open Muse" runs every web panel + the API from one
# in-app server — no external node/repo/dev-servers. The Swift ServerManager
# spawns muse-api-bin with MUSE_WEB_DIR pointing at the bundled web/.
RES="$(cd "$APP/Contents/Resources" && pwd)"
[ -f "$REPO/apps/api/dist/index.js" ] || { echo "API dist missing — run 'pnpm --filter @muse/api build' first" >&2; exit 1; }
echo "building web UI…"
( cd "$REPO" && pnpm --filter @muse/web build >/dev/null )
[ -f "$REPO/apps/web/dist/index.html" ] || { echo "web build missing (apps/web/dist)" >&2; exit 1; }
rm -rf "$RES/web"; cp -R "$REPO/apps/web/dist" "$RES/web"
echo "building self-contained API binary…"
# One build id ties the api binary (baked into /api/health) to this bundle's
# Info.plist (MuseBuildId) — the desktop reuses a running server only on match.
BUILD_ID="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)-$(date +%Y%m%d%H%M%S)"
MUSE_BUILD_ID="$BUILD_ID" bun "$PWD/scripts/build-api-binary.mjs" "$RES/muse-api-bin"
chmod +x "$RES/muse-api-bin"

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
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>MuseBuildId</key><string>${BUILD_ID}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>${MINIMUM_SYSTEM_VERSION}</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Muse listens to your voice so you can ask about your notes hands-free. Audio is transcribed on-device and never leaves your Mac.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Muse turns your spoken question into text on-device. Your speech never leaves your Mac.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Muse reads a document only when you explicitly ask it to open or summarize a file in your Documents folder.</string>
  <key>NSDesktopFolderUsageDescription</key><string>Muse reads a file on your Desktop only when you explicitly ask it to open or summarize that file.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Muse reads a file in Downloads only when you explicitly ask it to open or summarize that file.</string>
  <key>NSHumanReadableCopyright</key><string>(c) 2026</string>
</dict>
</plist>
PLIST

# TCC (mic/speech/Documents…) keys a granted permission to the bundle's code
# signature. An AD-HOC signature ("-") has NO stable Designated Requirement, so
# macOS may re-prompt on EVERY rebuild — and, for some folders, on every launch.
# A STABLE self-signed identity fixes that: its Designated Requirement is
# constant across rebuilds, so a grant ("Allow") persists. So prefer a local
# code-signing identity named "Muse Local Signing" (create it once with
# scripts/make-signing-cert.sh) and fall back to ad-hoc when it's absent.
SIGN_ID="Muse Local Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$SIGN_ID"; then
  if codesign --force --options runtime --sign "$SIGN_ID" "$APP" >/dev/null 2>&1 \
      && codesign --verify --deep "$APP" >/dev/null 2>&1; then
    echo "code-signed with stable local identity '$SIGN_ID' — TCC grants persist across rebuilds"
  else
    echo "WARNING: signing with '$SIGN_ID' failed — falling back to ad-hoc" >&2
    codesign --force --sign - "$APP" >/dev/null 2>&1 || true
  fi
elif codesign --force --sign - "$APP" >/dev/null 2>&1 && codesign --verify --deep "$APP" >/dev/null 2>&1; then
  echo "code-signed (ad-hoc) — mic/speech permission can be granted."
  echo "  NOTE: ad-hoc has no stable identity, so macOS may re-prompt for permissions"
  echo "  on rebuilds. To make grants persist, run scripts/make-signing-cert.sh ONCE"
  echo "  (creates a local '$SIGN_ID' cert), then rebuild."
else
  echo "WARNING: codesign failed — the bundle runs, but mic/speech (voice input) won't work until it's signed" >&2
fi

# Validate the plist so a typo can't silently break TCC.
plutil -lint "$APP/Contents/Info.plist"
node "$METADATA_VERIFIER" "$APP"
echo "built $APP — open it with:  open $APP"
