#!/bin/bash
set -euo pipefail

DEMO_USER_HOME="${MUSE_DEMO_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/muse-demo-home.XXXXXX")}"
mkdir -p "$DEMO_USER_HOME/.muse/notes"
cat > "$DEMO_USER_HOME/.muse/notes/birthday.md" <<'NOTE'
# Mina's birthday party

Booked the rooftop table at Butter&Crumb for Saturday 7pm.
Still to do: order the cake (they need 3 days notice) and invite Joon.
NOTE
ADDED=$(env HOME="$DEMO_USER_HOME" muse tasks add "Order the cake (3 days notice)" 2>/dev/null)
echo "$ADDED" | grep -oE 'task_[a-zA-Z0-9-]+' | head -1 > "$DEMO_USER_HOME/.taskid"
printf 'Demo data: %s\n' "$DEMO_USER_HOME"
