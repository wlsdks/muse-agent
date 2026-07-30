#!/bin/bash
export PATH="/Users/jinan/.local/bin:$PATH"
export HOME=/private/tmp/claude-501/-Users-jinan-orca-workspaces-Muse-main/6c778098-79bf-417c-aed0-3e7ea3fa5bb7/scratchpad/demohome
rm -rf "$HOME"; mkdir -p "$HOME/.muse/notes"
cat > "$HOME/.muse/notes/birthday.md" <<'NOTE'
# Mina's birthday party

Booked the rooftop table at Butter&Crumb for Saturday 7pm.
Still to do: order the cake (they need 3 days notice) and invite Joon.
NOTE
ADDED=$(muse tasks add "Order the cake (3 days notice)" 2>/dev/null)
echo "$ADDED" | grep -oE 'task_[a-zA-Z0-9-]+' | head -1 > "$HOME/.taskid"
