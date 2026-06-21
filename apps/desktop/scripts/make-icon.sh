#!/usr/bin/env bash
# Build AppIcon.icns (the goddess) from the README hero PNG, with macOS's
# native tools (sips + iconutil). Run once; the .icns is committed and copied
# into the app bundle by make-app.sh.
set -euo pipefail
cd "$(dirname "$0")/.."   # → apps/desktop

SRC="../../docs/assets/muse-goddess.png"   # opaque (black background) hero
[ -f "$SRC" ] || { echo "source missing: $SRC" >&2; exit 1; }

WORK="$(mktemp -d)"
SQUARE="$WORK/square.png"
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"

# Pad the portrait hero onto a square black canvas (matches its own backdrop,
# so the icon is seamless full-bleed).
SIZE=654
sips -s format png --padColor 000000 -p "$SIZE" "$SIZE" "$SRC" --out "$SQUARE" >/dev/null

for s in 16 32 128 256 512; do
  sips -z "$s" "$s"        "$SQUARE" --out "$ICONSET/icon_${s}x${s}.png"    >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d"        "$SQUARE" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o AppIcon.icns
rm -rf "$WORK"
echo "built apps/desktop/AppIcon.icns"
